<?php

/**
 * Keel single sign-on for Roundcube.
 *
 * The account panel opens the webmail as ?_keel=<token>, a 60 s single-use
 * token it minted for one of the account's mailboxes. This plugin exchanges it
 * over loopback with the panel (GET /api/panel/sso/webmail/<token>), which
 * answers once with the Dovecot master credential for that mailbox, logs the
 * session in and redirects to the mailbox. Anything that goes wrong falls back
 * to the ordinary login form with a notice; the token never reaches a log.
 *
 * The mailbox is authenticated through SASL PLAIN with an authorization
 * identity: the mailbox is the user Roundcube logs in (so password logins and
 * single sign-on share one Roundcube user record, identities, contacts and
 * settings), the master user and its password are the authentication
 * identity Dovecot checks (IMAP, and SMTP through Exim's dovecot
 * authenticators). The master user is kept in the session and re-applied to
 * the IMAP/SMTP settings on every request of that session.
 *
 * Installed by Keel into the Roundcube plugins/ directory and enabled through
 * the Keel block of config.inc.php ($config['plugins'][] = 'keel_sso';
 * $config['keel_sso_endpoint'] = '<panel loopback listener>').
 *
 * @license GPL-3.0-or-later
 */
class keel_sso extends rcube_plugin
{
    const TOKEN_RE = '/^[A-Za-z0-9_-]{32,128}$/';
    const MASTER_RE = '/^[a-z][a-z0-9_-]{0,31}$/';
    const MAILBOX_RE = '/^[^@\s*]+@[^@\s*]+$/';
    const DEFAULT_ENDPOINT = 'https://127.0.0.1:2087/api/panel/sso/webmail/';

    private $rcmail;

    public function init()
    {
        $this->rcmail = rcmail::get_instance();
        $this->add_hook('startup', [$this, 'startup']);
    }

    /**
     * A session signed on by the panel gets its master credential back on
     * every request; a ?_keel= token is exchanged and logged in.
     */
    public function startup($args)
    {
        $token = isset($_GET['_keel']) ? (string) $_GET['_keel'] : '';
        if ($token === '') {
            $this->apply_master();
            return $args;
        }

        if (!preg_match(self::TOKEN_RE, $token)) {
            return $this->fail($args, 'invalidrequest');
        }

        $cred = $this->exchange($token);
        if (!is_array($cred)) {
            return $this->fail($args, $cred ?: 'loginfailed');
        }

        // Already in that mailbox: keep the session, drop the token from the URL.
        if (!empty($this->rcmail->user->ID) && !empty($_SESSION['username'])
            && strcasecmp((string) $_SESSION['username'], $cred['mailbox']) === 0
        ) {
            $this->apply_master();
            $this->redirect(['_task' => 'mail']);
        }

        // Same sequence as index.php's login action: a clean session, the
        // storage login, a new session id, then the redirect to the mailbox.
        $this->rcmail->kill_session();
        $this->set_master($cred['masterUser'], $cred['password']);

        if (!$this->rcmail->login($cred['mailbox'], $cred['password'], $cred['host'], false)) {
            $this->rcmail->kill_session();
            return $this->fail($args, 'loginfailed');
        }

        $this->rcmail->session->remove('temp');
        $this->rcmail->session->regenerate_id(false);
        $this->rcmail->session->set_auth_cookie();
        $this->rcmail->log_login();
        $_SESSION['keel_sso'] = $cred['masterUser'];

        $redir = $this->rcmail->plugins->exec_hook('login_after', ['_task' => 'mail']);
        unset($redir['abort'], $redir['_err']);
        $this->redirect($redir);
    }

    /**
     * The master password is the session password (Roundcube keeps it
     * encrypted, as it does for any login); the master user rides in the
     * session next to it, so only a panel-signed session gets the proxy
     * authentication.
     */
    private function apply_master()
    {
        if (empty($_SESSION['keel_sso']) || empty($_SESSION['user_id']) || empty($_SESSION['password'])) {
            return;
        }
        $master = (string) $_SESSION['keel_sso'];
        if (!preg_match(self::MASTER_RE, $master)) {
            return;
        }
        $this->set_master($master, (string) $this->rcmail->decrypt($_SESSION['password']));
    }

    private function set_master($master, $password)
    {
        $config = $this->rcmail->config;
        $config->set('imap_auth_type', 'PLAIN');
        $config->set('imap_auth_cid', $master);
        $config->set('imap_auth_pw', $password);
        // Net_SMTP would otherwise prefer LOGIN, which carries no authorization identity.
        $config->set('smtp_auth_type', 'PLAIN');
        $config->set('smtp_auth_cid', $master);
        $config->set('smtp_auth_pw', $password);
    }

    private function redirect($params)
    {
        if (is_object($this->rcmail->output) && method_exists($this->rcmail->output, 'redirect')) {
            $this->rcmail->output->redirect($params, 0, true);
        }
        header('Location: ' . $this->rcmail->url($params, true, false));
        exit;
    }

    /**
     * GET <endpoint><token> on the loopback panel. The panel's own certificate
     * is a service certificate for the hostname, not for 127.0.0.1, so peer
     * verification is skipped only when the endpoint host is loopback; any
     * other host keeps full verification.
     *
     * The panel answers { user: '<mailbox>*<master>', password, host, mailbox }
     * (optionally masterUser); the mailbox and the master user are taken apart
     * here.
     *
     * @return array|string  ['mailbox','masterUser','password','host'] or an error label
     */
    private function exchange($token)
    {
        if (!function_exists('curl_init')) {
            return 'storageerror';
        }

        $endpoint = (string) $this->rcmail->config->get('keel_sso_endpoint', self::DEFAULT_ENDPOINT);
        $parts = parse_url($endpoint);
        if (!is_array($parts) || empty($parts['host']) || empty($parts['scheme'])) {
            return 'storageerror';
        }
        $host = strtolower(trim($parts['host'], '[]'));
        $loopback = in_array($host, ['127.0.0.1', '::1', 'localhost'], true) || strpos($host, '127.') === 0;
        $url = rtrim($endpoint, '/') . '/' . rawurlencode($token);

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_HTTPHEADER => ['Accept: application/json'],
            CURLOPT_SSL_VERIFYPEER => !$loopback,
            CURLOPT_SSL_VERIFYHOST => $loopback ? 0 : 2,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
        ]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        curl_close($ch);

        if ($body === false || $error) {
            rcube::raise_error(['code' => 500, 'message' => 'keel_sso: panel exchange failed: ' . $error], true, false);
            return 'storageerror';
        }
        if ($status === 404) {
            return 'loginfailed';
        }
        if ($status !== 200) {
            rcube::raise_error(['code' => 500, 'message' => 'keel_sso: panel exchange answered HTTP ' . $status], true, false);
            return 'storageerror';
        }

        $json = json_decode($body, true);
        $data = is_array($json) && isset($json['data']) && is_array($json['data']) ? $json['data'] : null;
        if (!$data || empty($data['user']) || !isset($data['password']) || empty($data['host'])
            || !is_string($data['user']) || !is_string($data['password']) || !is_string($data['host'])
        ) {
            return 'storageerror';
        }

        $sep = strpos($data['user'], '*');
        $mailbox = isset($data['mailbox']) && is_string($data['mailbox']) ? $data['mailbox']
            : ($sep !== false ? substr($data['user'], 0, $sep) : $data['user']);
        $master = isset($data['masterUser']) && is_string($data['masterUser']) ? $data['masterUser']
            : ($sep !== false ? substr($data['user'], $sep + 1) : '');
        if (!preg_match(self::MAILBOX_RE, $mailbox) || !preg_match(self::MASTER_RE, $master)) {
            return 'storageerror';
        }

        return ['mailbox' => $mailbox, 'masterUser' => $master, 'password' => $data['password'], 'host' => $data['host']];
    }

    /**
     * A notice; without a session the task is forced to login so no other
     * hook sees a half-authenticated request, with one the current mailbox
     * stays open.
     */
    private function fail($args, $label)
    {
        if (is_object($this->rcmail->output) && method_exists($this->rcmail->output, 'show_message')) {
            $this->rcmail->output->show_message($label, 'warning');
        }
        if (!empty($this->rcmail->user->ID)) {
            $this->apply_master();
            return $args;
        }
        $args['task'] = 'login';
        $args['action'] = '';
        return $args;
    }
}
