/**
 * 线索相关 Zod schema
 */
import { z } from 'zod';

export const leadImportItemSchema = z.object({
  company_name: z.string().min(1, '公司名称必填').max(200),
  contact_name: z.string().max(120).nullish(),
  email: z.string().email('邮箱格式不正确').max(200),
  phone: z.string().max(60).nullish(),
  website: z.string().max(300).nullish(),
  industry: z.string().max(120).nullish(),
  country: z.string().max(80).nullish(),
  company_size: z.string().max(40).nullish(),
  source: z.string().max(60).nullish(),
  notes: z.string().max(2000).nullish(),
  raw_payload: z.unknown().optional(),
  score: z.number().int().min(0).max(100).optional(),
  score_reason: z.string().max(500).optional(),
});

export type LeadImportItem = z.infer<typeof leadImportItemSchema>;

export const leadImportBodySchema = z.object({
  leads: z.array(leadImportItemSchema).min(1, '至少导入 1 条线索').max(200, '单次最多导入 200 条'),
  source: z.string().max(60).optional(),
  /** 是否同时运行评分工具（默认 true） */
  score: z.boolean().optional(),
  /** 是否把导入的线索交给完整工作流处理 */
  run_workflow: z.boolean().optional(),
});

export type LeadImportBody = z.infer<typeof leadImportBodySchema>;

export const leadQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(200).optional(),
});

export type LeadQuery = z.infer<typeof leadQuerySchema>;
