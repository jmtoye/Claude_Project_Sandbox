// Server-side search, restricted by the same visibility predicate as every other query.
import { projectScope, type Principal } from './auth/principal';
import type { Deps } from './config';

export interface SearchHit {
  id: string;
  name: string;
  space: string;
  lifecycle: string;
  match: string;
}

export async function searchProjects(deps: Deps, principal: Principal, query: string, space?: string): Promise<SearchHit[]> {
  const q = `%${query.trim().replace(/[%_\\]/g, (c) => '\\' + c)}%`;
  if (q.length < 3) return [];
  const scope = projectScope(principal, 'p');
  const spaceSql = space ? 'AND p.space = ?' : '';
  const params = [...scope.params, ...(space ? [space] : [])];
  const like = (col: string) => `${col} LIKE ? ESCAPE '\\'`;
  return deps.db.all<SearchHit>(
    `SELECT p.id, p.name, p.space, p.lifecycle, 'project' AS match FROM projects p
       WHERE ${scope.sql} ${spaceSql} AND (${like('p.name')} OR ${like('p.status_summary')} OR ${like('p.status_detail')})
     UNION
     SELECT p.id, p.name, p.space, p.lifecycle, 'milestone: ' || m.title FROM milestones m JOIN projects p ON p.id = m.project_id
       WHERE ${scope.sql} ${spaceSql} AND ${like('m.title')}
     UNION
     SELECT p.id, p.name, p.space, p.lifecycle, 'next step: ' || s.title FROM next_steps s JOIN projects p ON p.id = s.project_id
       WHERE ${scope.sql} ${spaceSql} AND ${like('s.title')}
     UNION
     SELECT p.id, p.name, p.space, p.lifecycle, i.kind || ': ' || i.title FROM issues i JOIN projects p ON p.id = i.project_id
       WHERE ${scope.sql} ${spaceSql} AND ${like('i.title')}
     LIMIT 50`,
    [...params, q, q, q, ...params, q, ...params, q, ...params, q],
  );
}
