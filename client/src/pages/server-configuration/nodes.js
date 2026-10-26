// Link Server Nodes: the only keys PUT/POST /server-config/nodes accept. A node
// row from the list also carries id, status, remote and timestamps, which the
// strict API schema rejects, so edit forms are trimmed to these before saving.
export const NODE_EDITABLE_KEYS = ['name', 'hostname', 'port', 'scheme', 'username', 'verifyTls', 'roles', 'enabled'];
export const EMPTY_NODE = { name: '', hostname: '', port: 2087, scheme: 'https', username: 'root', token: '', verifyTls: true, roles: [], enabled: true };

export function nodeFormValues(node) {
  if (!node) return { ...EMPTY_NODE };
  return { ...EMPTY_NODE, ...Object.fromEntries(NODE_EDITABLE_KEYS.filter((k) => node[k] !== undefined).map((k) => [k, node[k]])), token: '' };
}

export function nodeRequestBody(form, { editing }) {
  const body = Object.fromEntries(NODE_EDITABLE_KEYS.map((k) => [k, form[k]]));
  if (form.token || !editing) body.token = form.token;
  return body;
}
