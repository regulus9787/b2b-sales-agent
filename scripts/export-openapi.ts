/**
 * 导出 OpenAPI 规范到 docs/openapi.json
 *   npm run openapi
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildOpenApiSpec } from '../src/docs/openapi';

const main = (): void => {
  const spec = buildOpenApiSpec();
  const target = path.resolve(__dirname, '../docs/openapi.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

  const paths = Object.keys((spec.paths ?? {}) as Record<string, unknown>);
  const schemas = Object.keys(
    ((spec.components as { schemas?: Record<string, unknown> } | undefined)?.schemas ??
      {}) as Record<string, unknown>,
  );

  // eslint-disable-next-line no-console
  console.log(`[openapi] 已写入 ${target}`);
  // eslint-disable-next-line no-console
  console.log(`[openapi] 接口 ${paths.length} 个：\n  - ${paths.join('\n  - ')}`);
  // eslint-disable-next-line no-console
  console.log(`[openapi] 数据模型 ${schemas.length} 个：${schemas.join(', ')}`);
};

main();
