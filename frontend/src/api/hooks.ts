/**
 * TanStack Query hooks：所有服务端状态的唯一入口
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from './client';
import type {
  AgentRunDetail,
  AgentRunResult,
  CustomerDetail,
  CustomerStatus,
  CustomerSummary,
  DashboardStats,
  EmailGenerateResult,
  HealthInfo,
  LeadImportResult,
  Paginated,
  ReplyAnalyzeResult,
  ReplyIntent,
} from './types';

export const queryKeys = {
  health: ['health'] as const,
  customers: (params: Record<string, unknown>) => ['customers', params] as const,
  customer: (id: number) => ['customer', id] as const,
  dashboard: ['dashboard'] as const,
  agentTools: ['agent-tools'] as const,
  agentRun: (runId: string) => ['agent-run', runId] as const,
};

export interface CustomerListParams {
  page: number;
  pageSize: number;
  status?: CustomerStatus;
  search?: string;
  sortBy?: 'created_at' | 'updated_at' | 'score' | 'company_name';
  sortOrder?: 'asc' | 'desc';
}

export const useHealth = () =>
  useQuery({
    queryKey: queryKeys.health,
    queryFn: () => api.get<HealthInfo>('/health'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

export const useCustomers = (params: CustomerListParams) =>
  useQuery({
    queryKey: queryKeys.customers(params as unknown as Record<string, unknown>),
    queryFn: () =>
      api.get<Paginated<CustomerSummary>>('/api/customers', {
        page: params.page,
        pageSize: params.pageSize,
        ...(params.status ? { status: params.status } : {}),
        ...(params.search ? { search: params.search } : {}),
        ...(params.sortBy ? { sortBy: params.sortBy } : {}),
        ...(params.sortOrder ? { sortOrder: params.sortOrder } : {}),
      }),
    placeholderData: (previous) => previous,
  });

export const useCustomer = (id: number | null) =>
  useQuery({
    queryKey: queryKeys.customer(id ?? 0),
    queryFn: () => api.get<CustomerDetail>(`/api/customers/${id}`),
    enabled: id !== null && Number.isFinite(id) && id > 0,
  });

export const useDashboardStats = () =>
  useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: () => api.get<DashboardStats>('/api/dashboard/stats'),
    refetchInterval: 30_000,
  });

export const useAgentTools = () =>
  useQuery({
    queryKey: queryKeys.agentTools,
    queryFn: () =>
      api.get<{
        tools: { name: string; description: string }[];
        tool_names: string[];
        workflows: { name: string; description: string }[];
      }>('/api/agent/tools'),
    staleTime: 300_000,
  });

export const useAgentRun = (runId: string | null) =>
  useQuery({
    queryKey: queryKeys.agentRun(runId ?? ''),
    queryFn: () => api.get<AgentRunDetail>(`/api/agent/runs/${runId}`),
    enabled: Boolean(runId),
  });

/** 运行工作流 */
export const useRunAgent = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      workflow: 'full_cycle' | 'import_and_draft' | 'classify_only';
      customer_id?: number;
      leads?: unknown[];
      simulate_intent?: ReplyIntent;
      send_email?: boolean;
      limit?: number;
      trigger?: string;
    }) => api.post<AgentRunResult>('/api/agent/run', { trigger: 'frontend', ...input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['customer'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
      void queryClient.invalidateQueries({ queryKey: ['agent-run'] });
    },
  });
};

/** 生成邮件（单步） */
export const useGenerateEmail = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { customerId: number; send?: boolean }) =>
      api.post<EmailGenerateResult>(`/api/email/generate/${input.customerId}`, {
        send: input.send ?? true,
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.customer(variables.customerId) });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
};

/** 分析回复（单步） */
export const useAnalyzeReply = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { customerId: number; body?: string; simulate?: boolean; intent?: ReplyIntent }) =>
      api.post<ReplyAnalyzeResult>(`/api/reply/analyze/${input.customerId}`, {
        body: input.body,
        simulate: input.simulate ?? !input.body,
        intent: input.intent,
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.customer(variables.customerId) });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
};

/** 导入线索 */
export const useImportLeads = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { leads: unknown[]; source?: string; run_workflow?: boolean }) =>
      api.post<LeadImportResult>('/api/leads/import', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
};
