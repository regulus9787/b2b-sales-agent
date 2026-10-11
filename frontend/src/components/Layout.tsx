import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useHealth } from '../api/hooks';

const navItems = [
  { to: '/', label: '看板', icon: '📊' },
  { to: '/customers', label: '客户列表', icon: '🏢' },
  { to: '/workflow', label: '工作流触发', icon: '⚡' },
];

export const Layout = ({ children }: { children: ReactNode }) => {
  const health = useHealth();

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-6 py-3">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-lg text-white">
              ⚡
            </span>
            <div>
              <div className="text-sm font-semibold text-slate-900">B2B Sales Agent</div>
              <div className="text-xs text-slate-500">线索 → 开发信 → 意图分类 → 状态推进</div>
            </div>
          </div>

          <nav className="flex flex-1 items-center gap-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-brand-50 text-brand-700'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`
                }
              >
                <span className="mr-1">{item.icon}</span>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-2 text-xs">
            {health.isLoading && <span className="text-slate-400">连接中…</span>}
            {health.isError && (
              <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-1 text-rose-700">
                后端未连接（请先 npm run dev）
              </span>
            )}
            {health.data && (
              <>
                <span
                  className={`rounded-full border px-2 py-1 ${
                    health.data.llm.mode === 'mock'
                      ? 'border-amber-200 bg-amber-50 text-amber-700'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  }`}
                >
                  LLM: {health.data.llm.mode === 'mock' ? 'Mock 模式' : health.data.llm.model}
                </span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-slate-600">
                  DB v{health.data.schema_version} · {health.data.agent_tools.length} 工具
                </span>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">{children}</main>

      <footer className="border-t border-slate-200 bg-white py-4">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-6 text-xs text-slate-500">
          <span>B2B Sales Agent · Express 5 + better-sqlite3 + React 18</span>
          <span>
            API 文档：<a className="text-brand-600 hover:underline" href="http://localhost:3000/docs">http://localhost:3000/docs</a>
            {' · '}
            健康检查：<a className="text-brand-600 hover:underline" href="http://localhost:3000/health">http://localhost:3000/health</a>
          </span>
        </div>
      </footer>
    </div>
  );
};

export default Layout;
