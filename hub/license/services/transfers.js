import { paginate } from '../../shared/db.js';

export function createTransfersService(ctx) {
  const db = ctx.dbs.license;
  return {
    request: (input) => ctx.activations.transfer(input),
    list(query = {}, scope = null) {
      const where = [];
      const params = {};
      if (scope?.resellerId) { where.push('l.reseller_id = @reseller'); params.reseller = scope.resellerId; }
      if (query.license_id) { where.push('t.license_id = @license'); params.license = query.license_id; }
      return paginate(db, { select: 't.*, l.key_prefix', from: 'transfers t JOIN licenses l ON l.id = t.license_id', where, params, sortable: { requested_at: 't.requested_at' }, defaultSort: 'requested_at', query: { dir: 'desc', ...query } });
    },
  };
}
