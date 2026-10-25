import { paginate } from '../db/index.js';

export function createAuditService({ db }) {
  return {
    list(query) {
      const where = [];
      const params = {};
      if (query.q) { where.push('(action LIKE @q OR target LIKE @q OR principal LIKE @q OR ip LIKE @q)'); params.q = `%${query.q}%`; }
      if (query.principal) { where.push('principal = @principal'); params.principal = query.principal; }
      if (query.action) { where.push('action LIKE @action'); params.action = `${query.action}%`; }
      if (query.result) { where.push('result = @result'); params.result = query.result; }
      return paginate(db, { select: '*', from: 'audit_log', where, params, sortable: { ts: 'ts', action: 'action', principal: 'principal' }, defaultSort: 'ts', query: { ...query, dir: query.dir || 'desc' } });
    },
    loginAttempts(query) {
      return paginate(db, { select: '*', from: 'login_attempts', sortable: { created_at: 'created_at', ip: 'ip' }, defaultSort: 'created_at', query: { ...query, dir: query.dir || 'desc' } });
    },
  };
}
