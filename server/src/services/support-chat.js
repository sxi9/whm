import { EventEmitter } from 'node:events';
import { paginate } from '../db/index.js';
import { notFound, forbidden } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';

// Account Conversations: one support thread per hosting account. The manager
// side is root, the account's owner and its assigned manager; the account side
// is the hosted-account login (a `user` role row named like the account).
// Attached as ctx.supportChat.

export const CONVERSATION_STATUSES = ['open', 'closed'];
export const MESSAGE_MAX_CHARS = 4000;
export const EVENT_MESSAGE = 'support.chat.message';
export const EVENT_STATUS = 'support.chat.status';
export const PREVIEW_CHARS = 120;

export const sideOf = (user) => (user?.role === 'user' ? 'account' : 'manager');
const otherSide = (side) => (side === 'manager' ? 'account' : 'manager');
const READ_COLUMN = { manager: 'read_by_manager_at', account: 'read_by_account_at' };

const ACCOUNT_SELECT = `a.id, a.username, a.domain, a.owner_id, a.manager_user_id, a.contact_email, a.suspended, u.username AS owner,
  m.username AS manager, m.email AS manager_email, m.role AS manager_role`;
const ACCOUNT_FROM = 'accounts a JOIN users u ON u.id = a.owner_id LEFT JOIN users m ON m.id = a.manager_user_id';

export function createSupportChatService(ctx) {
  const { db, logger } = ctx;
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  const stmts = {
    account: db.prepare(`SELECT ${ACCOUNT_SELECT} FROM ${ACCOUNT_FROM} WHERE a.username = ?`),
    conversation: db.prepare('SELECT * FROM support_conversations WHERE account_id = ?'),
    conversationById: db.prepare('SELECT * FROM support_conversations WHERE id = ?'),
    insertConversation: db.prepare('INSERT INTO support_conversations (account_id, subject, status, last_message_at) VALUES (?, ?, ?, NULL)'),
    touch: db.prepare("UPDATE support_conversations SET last_message_at = @at, updated_at = @at, status = 'open' WHERE id = @id"),
    setStatus: db.prepare("UPDATE support_conversations SET status = ?, updated_at = datetime('now') WHERE id = ?"),
    setSubject: db.prepare("UPDATE support_conversations SET subject = ?, updated_at = datetime('now') WHERE id = ?"),
    insertMessage: db.prepare(`INSERT INTO support_messages (conversation_id, author_user_id, author_username, author_role, side, body, created_at)
      VALUES (@conversation_id, @author_user_id, @author_username, @author_role, @side, @body, @created_at)`),
    message: db.prepare('SELECT * FROM support_messages WHERE id = ?'),
    messages: db.prepare('SELECT * FROM support_messages WHERE conversation_id = @id AND (@before IS NULL OR id < @before) ORDER BY id DESC LIMIT @limit'),
    messageCount: db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE conversation_id = ?'),
    unreadFor: {
      manager: db.prepare("SELECT COUNT(*) AS n FROM support_messages WHERE conversation_id = ? AND side = 'account' AND read_by_manager_at IS NULL"),
      account: db.prepare("SELECT COUNT(*) AS n FROM support_messages WHERE conversation_id = ? AND side = 'manager' AND read_by_account_at IS NULL"),
    },
    markRead: {
      manager: db.prepare("UPDATE support_messages SET read_by_manager_at = @at WHERE conversation_id = @id AND side = 'account' AND read_by_manager_at IS NULL"),
      account: db.prepare("UPDATE support_messages SET read_by_account_at = @at WHERE conversation_id = @id AND side = 'manager' AND read_by_account_at IS NULL"),
    },
  };

  // Scheduler-less: every call carries a request, but the audit helper mirrors
  // the accounts service so internal callers without one still leave a row.
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(null, entry));
  const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Visibility: root sees every account; a reseller the accounts it owns or
  // manages; a hosted-account login only the account named like itself.
  function scopeSql(user, params) {
    if (isRoot(user)) return null;
    if (user.role === 'reseller') { params.uid = user.id; return '(a.owner_id = @uid OR a.manager_user_id = @uid)'; }
    params.uname = user.username;
    return 'a.username = @uname';
  }

  function inScope(account, user) {
    if (isRoot(user)) return true;
    if (user.role === 'reseller') return account.owner_id === user.id || account.manager_user_id === user.id;
    return user.role === 'user' && account.username === user.username;
  }

  function loadAccount(username, user) {
    const account = stmts.account.get(username);
    // A reseller probing for other resellers' accounts learns nothing from a 403.
    if (!account || !inScope(account, user)) throw notFound('Account');
    return account;
  }

  function shapeAccount(a) {
    return {
      id: a.id, username: a.username, domain: a.domain, owner: a.owner, suspended: Boolean(a.suspended), contactEmail: a.contact_email,
      manager: a.manager ? { username: a.manager, role: a.manager_role, email: a.manager_email } : null,
    };
  }

  function shapeConversation(c, side) {
    if (!c) return null;
    return {
      id: c.id, accountId: c.account_id, subject: c.subject, status: c.status, lastMessageAt: c.last_message_at, createdAt: c.created_at,
      messageCount: stmts.messageCount.get(c.id).n, unread: stmts.unreadFor[side].get(c.id).n,
    };
  }

  function shapeMessage(m) {
    return { id: m.id, conversationId: m.conversation_id, author: m.author_username, authorRole: m.author_role, side: m.side, body: m.body, createdAt: m.created_at, readByManagerAt: m.read_by_manager_at, readByAccountAt: m.read_by_account_at };
  }

  function publish(accountId, event) {
    bus.emit(`account:${accountId}`, event);
  }

  // Best effort: the other party learns there is something to read; the text
  // itself stays in the panel.
  function notify(account, message, req) {
    const send = ctx.contacts?.sendMail;
    if (!send) return;
    const to = message.side === 'account' ? account.manager_email : account.contact_email;
    if (!to) return;
    const host = ctx.settings.get('basic.hostname') || 'the panel';
    const subject = `[${host}] New support message for ${account.domain}`;
    const body = message.side === 'account'
      ? `${message.author_username} (hosting account ${account.username}, ${account.domain}) wrote in the account conversation. Open Support › Account Conversations in the panel to read and reply.`
      : `${message.author_username} replied in the support conversation for ${account.domain}. Log in to the panel to read it.`;
    Promise.resolve(send({ to, subject, body }, req)).catch((err) => logger.debug({ err: err.message, account: account.username }, 'support chat notification not sent'));
  }

  return {
    CONVERSATION_STATUSES,
    MESSAGE_MAX_CHARS,
    sideOf,
    EVENT_MESSAGE,

    // One row per account in scope, whether or not a thread exists yet, so a
    // manager can start the conversation from the list.
    listConversations(query, user) {
      const side = sideOf(user);
      const readCol = READ_COLUMN[side];
      const params = {};
      const where = [];
      const scope = scopeSql(user, params);
      if (scope) where.push(scope);
      if (query.q) { where.push('(a.username LIKE @q OR a.domain LIKE @q OR u.username LIKE @q OR m.username LIKE @q OR c.subject LIKE @q)'); params.q = `%${query.q}%`; }
      if (query.status) { where.push('c.status = @status'); params.status = query.status; }
      const unreadSql = `(SELECT COUNT(*) FROM support_messages x WHERE x.conversation_id = c.id AND x.side = '${otherSide(side)}' AND x.${readCol} IS NULL)`;
      if (query.unread) where.push(`${unreadSql} > 0`);
      const result = paginate(db, {
        select: `${ACCOUNT_SELECT}, c.id AS conversation_id, c.subject, c.status, c.last_message_at, ${unreadSql} AS unread,
          (SELECT COUNT(*) FROM support_messages x WHERE x.conversation_id = c.id) AS message_count,
          (SELECT substr(x.body, 1, ${PREVIEW_CHARS}) FROM support_messages x WHERE x.conversation_id = c.id ORDER BY x.id DESC LIMIT 1) AS last_preview,
          (SELECT x.author_username FROM support_messages x WHERE x.conversation_id = c.id ORDER BY x.id DESC LIMIT 1) AS last_author`,
        from: `${ACCOUNT_FROM} LEFT JOIN support_conversations c ON c.account_id = a.id`,
        where, params,
        sortable: { activity: 'c.last_message_at IS NULL, c.last_message_at', username: 'a.username', domain: 'a.domain', unread: 'unread', status: 'c.status' },
        defaultSort: 'activity', query,
      });
      return {
        data: result.data.map((r) => ({
          account: shapeAccount(r),
          conversation: r.conversation_id ? { id: r.conversation_id, subject: r.subject, status: r.status, lastMessageAt: r.last_message_at, messageCount: r.message_count, unread: r.unread, lastPreview: r.last_preview, lastAuthor: r.last_author } : null,
        })),
        meta: { ...result.meta, viewerSide: side },
      };
    },

    get(username, user, { before = null, limit = 100 } = {}) {
      const account = loadAccount(username, user);
      const side = sideOf(user);
      const conv = stmts.conversation.get(account.id);
      const messages = conv ? stmts.messages.all({ id: conv.id, before, limit }).reverse().map(shapeMessage) : [];
      return {
        account: shapeAccount(account), conversation: shapeConversation(conv, side), messages,
        hasMore: Boolean(conv) && messages.length === limit && stmts.messages.all({ id: conv.id, before: messages[0]?.id ?? null, limit: 1 }).length > 0,
        viewerSide: side, canModerate: side === 'manager',
      };
    },

    post(username, body, user, req) {
      const account = loadAccount(username, user);
      const side = sideOf(user);
      const at = now();
      const { conv, message, reopened, created } = db.transaction(() => {
        let c = stmts.conversation.get(account.id);
        let made = false;
        if (!c) {
          stmts.insertConversation.run(account.id, `Support for ${account.domain}`, 'open');
          c = stmts.conversation.get(account.id);
          made = true;
        }
        const wasClosed = c.status === 'closed';
        const { lastInsertRowid } = stmts.insertMessage.run({ conversation_id: c.id, author_user_id: user.id, author_username: user.username, author_role: user.role, side, body, created_at: at });
        stmts.touch.run({ id: c.id, at });
        return { conv: stmts.conversationById.get(c.id), message: stmts.message.get(lastInsertRowid), reopened: wasClosed, created: made };
      })();
      const shaped = shapeMessage(message);
      audit(req, { action: 'support.chat.post', target: username, args: { conversationId: conv.id, messageId: message.id, side, chars: body.length, reopened, created } });
      publish(account.id, { type: 'message', message: shaped, conversation: shapeConversation(conv, side) });
      ctx.events?.emit(EVENT_MESSAGE, { account: account.username, domain: account.domain, conversationId: conv.id, messageId: message.id, side, author: user.username, chars: body.length, reopened }, { req }).catch(() => {});
      notify(account, message, req);
      return { message: shaped, conversation: shapeConversation(conv, side), reopened, created };
    },

    markRead(username, user) {
      const account = loadAccount(username, user);
      const side = sideOf(user);
      const conv = stmts.conversation.get(account.id);
      if (!conv) return { updated: 0, unread: 0 };
      const at = now();
      const { changes } = stmts.markRead[side].run({ id: conv.id, at });
      if (changes) publish(account.id, { type: 'read', side, at, count: changes });
      return { updated: changes, unread: 0 };
    },

    update(username, { status, subject }, user, req) {
      const account = loadAccount(username, user);
      const side = sideOf(user);
      if (side !== 'manager') throw forbidden('Only the account manager can close or rename a conversation');
      let conv = stmts.conversation.get(account.id);
      if (!conv) {
        stmts.insertConversation.run(account.id, subject || `Support for ${account.domain}`, 'open');
        conv = stmts.conversation.get(account.id);
      }
      if (subject !== undefined) stmts.setSubject.run(subject, conv.id);
      if (status && status !== conv.status) stmts.setStatus.run(status, conv.id);
      conv = stmts.conversationById.get(conv.id);
      audit(req, { action: 'support.chat.update', target: username, args: { conversationId: conv.id, status: conv.status, subject: conv.subject } });
      publish(account.id, { type: 'status', status: conv.status, subject: conv.subject, by: user.username });
      if (status) ctx.events?.emit(EVENT_STATUS, { account: account.username, conversationId: conv.id, status: conv.status, by: user.username }, { req }).catch(() => {});
      return shapeConversation(conv, side);
    },

    // Top-bar badge figure: unread messages addressed to the viewer's side.
    unread(user) {
      const side = sideOf(user);
      const params = {};
      const where = ['c.id IS NOT NULL'];
      const scope = scopeSql(user, params);
      if (scope) where.push(scope);
      const rows = db.prepare(`SELECT a.username, a.domain, COUNT(x.id) AS unread FROM ${ACCOUNT_FROM}
        JOIN support_conversations c ON c.account_id = a.id
        JOIN support_messages x ON x.conversation_id = c.id AND x.side = '${otherSide(side)}' AND x.${READ_COLUMN[side]} IS NULL
        WHERE ${where.join(' AND ')} GROUP BY a.id ORDER BY unread DESC, a.username LIMIT 200`).all(params);
      return { total: rows.reduce((n, r) => n + r.unread, 0), conversations: rows.map((r) => ({ account: r.username, domain: r.domain, unread: r.unread })) };
    },

    // Live updates for one account's thread; the caller has already been
    // scoped through get(). Returns the unsubscribe function.
    subscribe(accountId, fn) {
      const key = `account:${accountId}`;
      bus.on(key, fn);
      return () => bus.off(key, fn);
    },

    // Exposed for the route's scope check without loading messages.
    account: (username, user) => shapeAccount(loadAccount(username, user)),
  };
}
