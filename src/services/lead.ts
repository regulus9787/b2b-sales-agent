/**
 * 线索服务（AGENTS.md 阶段 4）
 *  - 批量导入 + 去重（email + company_name 归一化哈希）
 *  - 规则评分 + 评分理由
 *  - 导入后创建 customer 并写 lead_imported 事件
 */
import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { AppError, ErrorCode, validationError } from '../core/errors';
import type { CustomerStatus } from '../core/status';
import { recordEvent } from '../core/events';
import { nowIso } from '../db/db';
import type { CustomerRow, LeadRow } from '../core/models';
import { toCustomerDto, type CustomerDto } from '../core/models';
import { leadImportItemSchema, type LeadImportItem } from '../schemas/lead';

/* ------------------------------------------------------------------ */
/* 评分（本地规则，LLM 只做增强解释）                                   */
/* ------------------------------------------------------------------ */

/** 高价值行业（与 prompts.ts 的行业痛点库对应） */
export const HIGH_VALUE_INDUSTRIES = [
  'SaaS 软件',
  '生物医药',
  '新能源',
  '金融科技',
  '数据服务',
  '消费电子制造',
] as const;

export const MEDIUM_VALUE_INDUSTRIES = ['精密机械', '电子元器件', '跨境物流'] as const;

/** 高价值市场 */
export const HIGH_VALUE_COUNTRIES = ['CN', 'US', 'DE', 'SG', 'JP', 'GB', 'NL', 'AU'] as const;

const SIZE_SCORES: Record<string, number> = {
  '1-10': 6,
  '10-50': 12,
  '50-100': 18,
  '100-500': 24,
  '500-1000': 26,
  '1000+': 28,
};

export const normalizeKey = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ');

/** 去重哈希：email + company_name */
export const dedupeHash = (email: string, companyName: string): string =>
  createHash('sha256')
    .update(`${normalizeKey(email)}|${normalizeKey(companyName)}`)
    .digest('hex')
    .slice(0, 32);

export interface ScoreInput {
  industry?: string | null;
  country?: string | null;
  company_size?: string | null;
  website?: string | null;
  phone?: string | null;
  contact_name?: string | null;
  notes?: string | null;
}

export interface ScoreResult {
  score: number;
  reason: string;
  signals: string[];
}

/**
 * 规则评分：0-100
 *  行业 0-26 + 规模 0-28 + 地区 0-16 + 联系方式完整度 0-20 + 备注意向 0-10
 */
export const scoreLead = (input: ScoreInput): ScoreResult => {
  const signals: string[] = [];
  let score = 0;

  // 行业
  const industry = input.industry ?? '';
  if ((HIGH_VALUE_INDUSTRIES as readonly string[]).includes(industry)) {
    score += 26;
    signals.push(`高价值行业(${industry}) +26`);
  } else if ((MEDIUM_VALUE_INDUSTRIES as readonly string[]).includes(industry)) {
    score += 18;
    signals.push(`中价值行业(${industry}) +18`);
  } else if (industry) {
    score += 10;
    signals.push(`行业匹配度一般(${industry}) +10`);
  } else {
    signals.push('缺少行业信息 +0');
  }

  // 规模
  const size = input.company_size ?? '';
  const sizeScore = SIZE_SCORES[size] ?? 10;
  score += sizeScore;
  signals.push(`团队规模(${size || '未知'}) +${sizeScore}`);

  // 地区
  const country = (input.country ?? '').toUpperCase();
  if ((HIGH_VALUE_COUNTRIES as readonly string[]).includes(country)) {
    score += 16;
    signals.push(`目标市场(${country}) +16`);
  } else if (country) {
    score += 8;
    signals.push(`非重点市场(${country}) +8`);
  } else {
    signals.push('缺少国家信息 +0');
  }

  // 联系方式完整度
  let contactScore = 0;
  if (input.website) contactScore += 8;
  if (input.phone) contactScore += 6;
  if (input.contact_name) contactScore += 6;
  score += contactScore;
  signals.push(`联系方式完整度 +${contactScore}`);

  // 备注意向信号
  const notes = input.notes ?? '';
  const intentKeywords =
    /(需求|意向|采购|评估|拓展|预算|合作|need|interest|budget|evaluat|expand)/i;
  if (intentKeywords.test(notes)) {
    score += 10;
    signals.push('备注含明确需求信号 +10');
  } else if (notes) {
    score += 4;
    signals.push('备注有背景信息 +4');
  }

  const finalScore = Math.max(0, Math.min(100, score));
  const grade = finalScore >= 80 ? 'A' : finalScore >= 65 ? 'B' : finalScore >= 45 ? 'C' : 'D';

  return {
    score: finalScore,
    reason: `等级 ${grade}｜${signals.join('；')}`,
    signals,
  };
};

/** 规则评分 → 初始状态（高分配直接 enriched，其余 new） */
export const statusForScore = (score: number): CustomerStatus => (score >= 70 ? 'enriched' : 'new');

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

export type LeadImportInput = LeadImportItem;

export interface ImportedLeadResult {
  lead_id: number;
  customer_id: number;
  email: string;
  company_name: string;
  deduplicated: boolean;
  score: number;
  score_reason: string;
  status: CustomerStatus;
  created: boolean;
}

export interface ImportLeadsResult {
  imported: number;
  duplicated: number;
  total: number;
  leads: ImportedLeadResult[];
}

export interface ImportLeadsOptions {
  source?: string;
  trigger?: string;
  runId?: string | null;
  requestId?: string | null;
  /** 是否为已有客户关联线索（不新建客户） */
  linkOnly?: boolean;
}

const parseIntOr = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : undefined;
};

/**
 * 批量导入线索：逐条去重 → 建客户 → 建线索 → 写事件。
 * 单条失败不影响整批（收集到 errors 中）。
 */
export const importLeads = (
  db: Database,
  items: LeadImportInput[],
  options: ImportLeadsOptions = {},
): ImportLeadsResult => {
  if (!Array.isArray(items) || items.length === 0) {
    throw validationError('线索列表不能为空', {
      source: 'body',
      issues: [{ path: 'leads', message: '至少 1 条' }],
    });
  }

  const parsed = z.array(leadImportItemSchema).safeParse(items);
  if (!parsed.success) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, '线索数据校验失败', {
      details: {
        source: 'body',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      },
    });
  }

  const results: ImportedLeadResult[] = [];
  let imported = 0;
  let duplicated = 0;

  const findCustomerByEmail = db.prepare('SELECT * FROM customers WHERE email = ?');
  const findLeadByHash = db.prepare('SELECT * FROM leads WHERE dedupe_hash = ?');
  const insertCustomer = db.prepare(`
    INSERT INTO customers (company_name, contact_name, email, phone, website, industry, country,
                           company_size, status, score, source, notes, created_at, updated_at)
    VALUES (@company_name, @contact_name, @email, @phone, @website, @industry, @country,
            @company_size, @status, @score, @source, @notes, @now, @now)
  `);
  const updateCustomerScore = db.prepare(
    'UPDATE customers SET score = @score, updated_at = @now WHERE id = @id',
  );
  const insertLead = db.prepare(`
    INSERT INTO leads (company_name, contact_name, email, phone, website, industry, country,
                       company_size, source, notes, raw_payload, score, score_reason, dedupe_hash,
                       customer_id, created_at, updated_at)
    VALUES (@company_name, @contact_name, @email, @phone, @website, @industry, @country,
            @company_size, @source, @notes, @raw_payload, @score, @score_reason, @dedupe_hash,
            @customer_id, @now, @now)
  `);
  const updateLeadCustomer = db.prepare(
    'UPDATE leads SET customer_id = @customer_id WHERE id = @id',
  );

  const run = db.transaction(() => {
    for (const item of parsed.data) {
      const email = item.email.trim().toLowerCase();
      const companyName = item.company_name.trim();
      const hash = dedupeHash(email, companyName);
      const score = item.score ?? scoreLead(item).score;
      const reason = item.score_reason ?? scoreLead(item).reason;
      const now = nowIso();

      const existingLead = findLeadByHash.get(hash) as LeadRow | undefined;
      const existingCustomer = findCustomerByEmail.get(email) as CustomerRow | undefined;

      // 线索已存在：直接返回既有关系
      if (existingLead) {
        const customerId = existingLead.customer_id ?? existingCustomer?.id;
        if (customerId === undefined || customerId === null) {
          throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            `线索 ${existingLead.id} 未关联客户，数据异常`,
          );
        }
        duplicated += 1;
        results.push({
          lead_id: existingLead.id,
          customer_id: customerId,
          email,
          company_name: companyName,
          deduplicated: true,
          score: existingLead.score,
          score_reason: existingLead.score_reason ?? '',
          status: (existingCustomer?.status ?? 'new') as CustomerStatus,
          created: false,
        });
        continue;
      }

      let customerId: number;
      let status: CustomerStatus;

      if (existingCustomer) {
        // 客户已存在（可能来自 seed 或其他来源）：复用并更新评分
        customerId = existingCustomer.id;
        status = existingCustomer.status;
        const newScore = Math.max(existingCustomer.score, score);
        updateCustomerScore.run({ id: customerId, score: newScore, now });
        duplicated += 1;
      } else if (options.linkOnly) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, `linkOnly 模式下客户不存在: ${email}`, {
          httpStatus: 400,
        });
      } else {
        status = statusForScore(score);
        const info = insertCustomer.run({
          company_name: companyName,
          contact_name: item.contact_name ?? null,
          email,
          phone: item.phone ?? null,
          website: item.website ?? null,
          industry: item.industry ?? null,
          country: item.country ?? null,
          company_size: item.company_size ?? null,
          status,
          score,
          source: item.source ?? options.source ?? 'api',
          notes: item.notes ?? null,
          now,
        });
        customerId = Number(info.lastInsertRowid);
        recordEvent(db, {
          customerId,
          eventType: 'lead_imported',
          fromStatus: null,
          toStatus: status,
          trigger: options.trigger ?? 'api',
          runId: options.runId ?? null,
          actor: 'lead_service',
          payload: {
            email,
            company_name: companyName,
            score,
            source: item.source ?? options.source ?? 'api',
          },
          requestId: options.requestId ?? null,
        });
        imported += 1;
      }

      const leadInfo = insertLead.run({
        company_name: companyName,
        contact_name: item.contact_name ?? null,
        email,
        phone: item.phone ?? null,
        website: item.website ?? null,
        industry: item.industry ?? null,
        country: item.country ?? null,
        company_size: item.company_size ?? null,
        source: item.source ?? options.source ?? 'api',
        notes: item.notes ?? null,
        raw_payload: item.raw_payload === undefined ? null : JSON.stringify(item.raw_payload),
        score,
        score_reason: reason,
        dedupe_hash: hash,
        customer_id: customerId,
        now,
      });
      const leadId = Number(leadInfo.lastInsertRowid);

      recordEvent(db, {
        customerId,
        eventType: 'lead_scored',
        fromStatus: status,
        toStatus: status,
        trigger: 'score_lead',
        runId: options.runId ?? null,
        actor: 'lead_service',
        payload: { lead_id: leadId, score, reason },
        requestId: options.requestId ?? null,
      });

      results.push({
        lead_id: leadId,
        customer_id: customerId,
        email,
        company_name: companyName,
        deduplicated: false,
        score,
        score_reason: reason,
        status,
        created: !existingCustomer,
      });
    }
  });

  run();

  // 关联线索的 customer_id（existingLead 场景下无需处理）
  void updateLeadCustomer;

  return { imported, duplicated, total: results.length, leads: results };
};

/** 重新为线索评分并更新（供 score_lead 工具使用） */
export const rescoreLead = (
  db: Database,
  leadId: number,
): {
  lead_id: number;
  customer_id: number | null;
  score: number;
  reason: string;
  signals: string[];
} => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as LeadRow | undefined;
  if (!lead) {
    throw new AppError(ErrorCode.LEAD_NOT_FOUND, `线索不存在: ${leadId}`, { httpStatus: 404 });
  }
  const result = scoreLead(lead);
  const now = nowIso();
  db.prepare('UPDATE leads SET score = ?, score_reason = ?, updated_at = ? WHERE id = ?').run(
    result.score,
    result.reason,
    now,
    leadId,
  );
  if (lead.customer_id !== null) {
    db.prepare('UPDATE customers SET score = ?, updated_at = ? WHERE id = ?').run(
      result.score,
      now,
      lead.customer_id,
    );
    recordEvent(db, {
      customerId: lead.customer_id,
      eventType: 'lead_scored',
      fromStatus: null,
      toStatus: null,
      trigger: 'score_lead',
      actor: 'lead_service',
      payload: { lead_id: leadId, score: result.score, reason: result.reason },
    });
  }
  return {
    lead_id: leadId,
    customer_id: lead.customer_id,
    score: result.score,
    reason: result.reason,
    signals: result.signals,
  };
};

/** 线索列表（分页） */
export interface ListLeadsOptions {
  page?: number;
  pageSize?: number;
  search?: string;
}

export const listLeads = (
  db: Database,
  options: ListLeadsOptions = {},
): { items: LeadRow[]; total: number; page: number; pageSize: number } => {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, options.pageSize ?? 20));
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const params: unknown[] = [];
  if (options.search) {
    where.push('(company_name LIKE ? OR email LIKE ? OR contact_name LIKE ?)');
    const like = `%${options.search}%`;
    params.push(like, like, like);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM leads ${whereSql}`).get(...params) as { c: number }
  ).c;
  const items = db
    .prepare(`SELECT * FROM leads ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset) as LeadRow[];

  return { items, total, page, pageSize };
};

export const getLeadById = (db: Database, leadId: number): LeadRow | null =>
  (db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as LeadRow | undefined) ?? null;

export const getCustomerByEmail = (db: Database, email: string): CustomerDto | null => {
  const row = db
    .prepare('SELECT * FROM customers WHERE email = ?')
    .get(email.trim().toLowerCase()) as CustomerRow | undefined;
  return row ? toCustomerDto(row) : null;
};

export { parseIntOr };
