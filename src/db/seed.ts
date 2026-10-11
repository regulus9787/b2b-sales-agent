/**
 * Seed：10 条模拟线索/客户（AGENTS.md 阶段 2 要求）
 * 幂等：按 email 去重，已存在则跳过；客户状态覆盖多种状态便于看板演示。
 */
import type { Database } from 'better-sqlite3';
import type { CustomerStatus } from '../core/status';
import { nowIso } from './db';

export interface SeedLead {
  company_name: string;
  contact_name: string;
  email: string;
  phone: string;
  website: string;
  industry: string;
  country: string;
  company_size: string;
  source: string;
  notes: string;
  status: CustomerStatus;
  score: number;
  score_reason: string;
}

export const SEED_LEADS: SeedLead[] = [
  {
    company_name: 'Shenzhen Nova Electronics Co., Ltd.',
    contact_name: 'Kevin Zhang',
    email: 'kevin.zhang@nova-electronics.example.com',
    phone: '+86-755-8899-1201',
    website: 'https://nova-electronics.example.com',
    industry: '消费电子制造',
    country: 'CN',
    company_size: '500-1000',
    source: 'seed',
    notes: '2025 年拓展欧洲渠道，正在寻找海外 B2B 获客方案',
    status: 'new',
    score: 82,
    score_reason: '规模匹配 + 明确海外拓展需求 + 有官网',
  },
  {
    company_name: 'Hangzhou CloudAxis Software',
    contact_name: 'Lily Chen',
    email: 'lily.chen@cloudaxis.example.com',
    phone: '+86-571-2233-4411',
    website: 'https://cloudaxis.example.com',
    industry: 'SaaS 软件',
    country: 'CN',
    company_size: '100-500',
    source: 'seed',
    notes: 'PLG 转 SLG，需要销售线索自动化',
    status: 'enriched',
    score: 76,
    score_reason: '行业高匹配 + 增长阶段',
  },
  {
    company_name: 'Suzhou PreciseTools Industrial',
    contact_name: 'Marcus Weber',
    email: 'marcus.weber@precisetools.example.com',
    phone: '+49-711-8899-220',
    website: 'https://precisetools.example.com',
    industry: '精密机械',
    country: 'DE',
    company_size: '200-500',
    source: 'seed',
    notes: '德国隐形冠军，关注供应商数字化',
    status: 'email_drafted',
    score: 71,
    score_reason: '欧洲市场 + 采购决策链清晰',
  },
  {
    company_name: 'Guangzhou Skyline Logistics',
    contact_name: 'Amy Liu',
    email: 'amy.liu@skyline-logistics.example.com',
    phone: '+86-20-3344-5566',
    website: 'https://skyline-logistics.example.com',
    industry: '跨境物流',
    country: 'CN',
    company_size: '1000+',
    source: 'seed',
    notes: '已发送第一封开发信，等待回复',
    status: 'contacted',
    score: 68,
    score_reason: '体量大但决策周期长',
  },
  {
    company_name: 'Singapore DataReef Analytics',
    contact_name: 'Jason Tan',
    email: 'jason.tan@datareef.example.com',
    phone: '+65-6221-8890',
    website: 'https://datareef.example.com',
    industry: '数据服务',
    country: 'SG',
    company_size: '50-100',
    source: 'seed',
    notes: '客户已回复，等待意图分类',
    status: 'replied',
    score: 74,
    score_reason: '东南亚增长市场 + 数据驱动团队',
  },
  {
    company_name: 'Beijing MedCore Biotech',
    contact_name: 'Dr. Wang Lei',
    email: 'wanglei@medcore-bio.example.com',
    phone: '+86-10-6677-8899',
    website: 'https://medcore-bio.example.com',
    industry: '生物医药',
    country: 'CN',
    company_size: '500-1000',
    source: 'seed',
    notes: '明确表达合作意向，等待会议安排',
    status: 'interested',
    score: 88,
    score_reason: '高意向 + 预算充足',
  },
  {
    company_name: 'Osaka Kirin Components',
    contact_name: 'Yuki Sato',
    email: 'yuki.sato@kirin-components.example.com',
    phone: '+81-6-6123-4567',
    website: 'https://kirin-components.example.com',
    industry: '电子元器件',
    country: 'JP',
    company_size: '100-500',
    source: 'seed',
    notes: '要求提供详细技术规格与合规文档',
    status: 'needs_info',
    score: 65,
    score_reason: '需补充资料，决策较慢',
  },
  {
    company_name: 'Mumbai Vertex Textiles',
    contact_name: 'Rajesh Kumar',
    email: 'rajesh.kumar@vertex-textiles.example.com',
    phone: '+91-22-4455-6677',
    website: 'https://vertex-textiles.example.com',
    industry: '纺织制造',
    country: 'IN',
    company_size: '1000+',
    source: 'seed',
    notes: '预算不足，明确拒绝本轮合作',
    status: 'rejected',
    score: 32,
    score_reason: '预算与需求不匹配',
  },
  {
    company_name: 'Shanghai FinEdge Capital',
    contact_name: 'Grace Zhou',
    email: 'grace.zhou@finedge.example.com',
    phone: '+86-21-5566-7788',
    website: 'https://finedge.example.com',
    industry: '金融科技',
    country: 'CN',
    company_size: '100-500',
    source: 'seed',
    notes: '回复中性，建议 30 天后跟进',
    status: 'neutral',
    score: 58,
    score_reason: '有需求但时机未到',
  },
  {
    company_name: 'Berlin GruenWerk Energy',
    contact_name: 'Anna Schmidt',
    email: 'anna.schmidt@gruenwerk.example.com',
    phone: '+49-30-2233-4455',
    website: 'https://gruenwerk.example.com',
    industry: '新能源',
    country: 'DE',
    company_size: '200-500',
    source: 'seed',
    notes: '已预约下周产品演示会议',
    status: 'meeting_booked',
    score: 79,
    score_reason: '已完成会议预约，进入成交阶段',
  },
];

export interface SeedResult {
  inserted: number;
  skipped: number;
  customerIds: number[];
}

/**
 * 写入 seed 数据：leads + customers 各一条，并记录一条 'lead_imported' 事件。
 */
export const seedDatabase = (db: Database, options: { silent?: boolean } = {}): SeedResult => {
  const insertedIds: number[] = [];
  let inserted = 0;
  let skipped = 0;

  const findCustomer = db.prepare('SELECT id FROM customers WHERE email = ?');
  const findLead = db.prepare('SELECT id FROM leads WHERE dedupe_hash = ?');
  const insertCustomer = db.prepare(`
    INSERT INTO customers (company_name, contact_name, email, phone, website, industry, country,
                           company_size, status, score, source, notes, created_at, updated_at)
    VALUES (@company_name, @contact_name, @email, @phone, @website, @industry, @country,
            @company_size, @status, @score, @source, @notes, @now, @now)
  `);
  const insertLead = db.prepare(`
    INSERT INTO leads (company_name, contact_name, email, phone, website, industry, country,
                       company_size, source, notes, raw_payload, score, score_reason, dedupe_hash,
                       customer_id, created_at, updated_at)
    VALUES (@company_name, @contact_name, @email, @phone, @website, @industry, @country,
            @company_size, @source, @notes, @raw_payload, @score, @score_reason, @dedupe_hash,
            @customer_id, @now, @now)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO events (customer_id, event_type, from_status, to_status, trigger, actor, payload, created_at)
    VALUES (@customer_id, 'lead_imported', NULL, @to_status, 'seed', 'seed', @payload, @now)
  `);

  const run = db.transaction(() => {
    for (const lead of SEED_LEADS) {
      const dedupeHash = `${lead.email.trim().toLowerCase()}|${lead.company_name.trim().toLowerCase()}`;
      const existingCustomer = findCustomer.get(lead.email) as { id: number } | undefined;
      if (existingCustomer) {
        skipped += 1;
        continue;
      }
      const now = nowIso();
      const info = insertCustomer.run({
        company_name: lead.company_name,
        contact_name: lead.contact_name,
        email: lead.email,
        phone: lead.phone,
        website: lead.website,
        industry: lead.industry,
        country: lead.country,
        company_size: lead.company_size,
        status: lead.status,
        score: lead.score,
        source: lead.source,
        notes: lead.notes,
        now,
      });
      const customerId = Number(info.lastInsertRowid);

      if (!findLead.get(dedupeHash)) {
        insertLead.run({
          company_name: lead.company_name,
          contact_name: lead.contact_name,
          email: lead.email,
          phone: lead.phone,
          website: lead.website,
          industry: lead.industry,
          country: lead.country,
          company_size: lead.company_size,
          source: lead.source,
          notes: lead.notes,
          raw_payload: JSON.stringify({ seeded: true, status: lead.status }),
          score: lead.score,
          score_reason: lead.score_reason,
          dedupe_hash: dedupeHash,
          customer_id: customerId,
          now,
        });
      }

      insertEvent.run({
        customer_id: customerId,
        to_status: lead.status,
        payload: JSON.stringify({ seeded: true, score: lead.score, reason: lead.score_reason }),
        now,
      });

      insertedIds.push(customerId);
      inserted += 1;
    }
  });

  run();

  if (!options.silent) {
    // eslint-disable-next-line no-console
    console.log(`[seed] 插入 ${inserted} 条客户，跳过 ${skipped} 条已存在客户`);
  }

  return { inserted, skipped, customerIds: insertedIds };
};

export default seedDatabase;
