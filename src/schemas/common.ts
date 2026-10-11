/**
 * 通用 Zod schema（分页、ID 等）
 */
import { z } from 'zod';

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive('id 必须是正整数'),
});

export const customerIdParamSchema = z.object({
  customerId: z.coerce.number().int().positive('customerId 必须是正整数'),
});

export const runIdParamSchema = z.object({
  runId: z.string().min(8, 'runId 长度不足').max(64),
});

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const paginationMetaSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

/** 计算分页 meta */
export const buildPaginationMeta = (page: number, pageSize: number, total: number) => ({
  page,
  pageSize,
  total,
  totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  meta: z.object({ request_id: z.string() }).passthrough(),
});

export const metaSchema = z
  .object({
    request_id: z.string().uuid(),
  })
  .passthrough();

/** 包装成功响应 schema：dataSchema + meta */
export const successEnvelope = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
    meta: metaSchema,
  });
