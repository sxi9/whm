<?php

/**
 * Keel single sign-on into phpMyAdmin.
 *
 * Published as /keel/pma-signon.php under the server-hostname site. The
 * account panel opens it as ?_keel=<token>, a 60 s single-use token minted for
 * the account's hidden phpMyAdmin user (<account>_pma, password rotated for
 * every sign-on). The token is exchanged over loopback with the panel
 * (GET /api/panel/sso/phpmyadmin/<token>), which answers once with
 * { user, password, host }; those land in the "KeelPmaSignon" session that
 * phpMyAdmin's signon authentication (conf.d/keel-signon.php) reads, and the
 * browser is sent to phpMyAdmin. Without a token the page explains where to
 * open phpMyAdmin from and offers the cookie login (server 2) instead.
 *
 * The token never reaches a log or the page; the password only ever sits in
 * the PHP session file.
 */

declare(strict_types=1);

const KEEL_PMA_SESSION = 'KeelPmaSignon';
const KEEL_PMA_INDEX = '/phpmyadmin/index.php';
const KEEL_PMA_CONF = '/etc/phpmyadmin/conf.d/keel-signon.php';
const KEEL_TOKEN_RE = '/^[A-Za-z0-9_-]{32,128}$/';
const KEEL_DEFAULT_ENDPOINT = 'https://127.0.0.1:2087/api/panel/sso/phpmyadmin/';

/**
 * The panel's loopback listener. The agent renders it as the KEEL_SSO_ENDPOINT
 * constant of the phpMyAdmin drop-in (the only file both phpMyAdmin and this
 * script read), so the drop-in is included here in a scope of its own; a
 * KEEL_SSO_ENDPOINT request variable (Apache SetEnv) or environment entry
 * comes next, then the default.
 */
function keel_pma_endpoint(): string
{
    if (!defined('KEEL_SSO_ENDPOINT') && is_readable(KEEL_PMA_CONF)) {
        (static function (): void {
            $cfg = [];
            include KEEL_PMA_CONF;
        })();
    }
    $candidates = [
        defined('KEEL_SSO_ENDPOINT') ? KEEL_SSO_ENDPOINT : '',
        $_SERVER['KEEL_SSO_ENDPOINT'] ?? '',
        getenv('KEEL_SSO_ENDPOINT') ?: '',
    ];
    foreach ($candidates as $value) {
        if (is_string($value) && preg_match('#^https?://[^/\s]+/\S*$#', $value)) {
            return $value;
        }
    }
    return KEEL_DEFAULT_ENDPOINT;
}

/**
 * GET <endpoint><token> on the loopback panel. Peer verification is skipped
 * only when the endpoint host is loopback (the panel's certificate names the
 * hostname, not 127.0.0.1); any other endpoint keeps full verification.
 *
 * @return array{user:string,password:string,host:string}|string credentials or an error label
 */
function keel_pma_exchange(string $token)
{
    if (!function_exists('curl_init')) {
        return 'curl_missing';
    }
    $endpoint = keel_pma_endpoint();
    $parts = parse_url($endpoint);
    if (!is_array($parts) || empty($parts['host']) || empty($parts['scheme'])) {
        return 'endpoint_invalid';
    }
    $host = strtolower(trim((string) $parts['host'], '[]'));
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

    if ($body === false || $error !== '') {
        error_log('keel pma-signon: panel exchange failed: ' . $error);
        return 'panel_unreachable';
    }
    if ($status === 404) {
        return 'token_invalid';
    }
    if ($status !== 200) {
        error_log('keel pma-signon: panel exchange answered HTTP ' . $status);
        return $status === 409 ? 'sso_disabled' : 'panel_error';
    }
    $json = json_decode((string) $body, true);
    $data = is_array($json) && isset($json['data']) && is_array($json['data']) ? $json['data'] : null;
    if ($data === null || empty($data['user']) || !isset($data['password']) || empty($data['host'])
        || !is_string($data['user']) || !is_string($data['password']) || !is_string($data['host'])
    ) {
        return 'panel_error';
    }
    return ['user' => $data['user'], 'password' => $data['password'], 'host' => $data['host']];
}

function keel_pma_start_session(): void
{
    session_name(KEEL_PMA_SESSION);
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'domain' => '',
        'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

function keel_pma_page(int $status, string $title, string $message): void
{
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');
    $h = static function (string $s): string {
        return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    };
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>', $h($title), '</title>',
        '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f4f5f7;color:#1c1c1e;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}',
        'main{background:#fff;border-radius:14px;padding:32px 36px;max-width:440px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;margin:0 0 12px}a{color:#0a66c2}</style></head><body><main>',
        '<h1>', $h($title), '</h1><p>', $h($message), '</p>',
        '<p>Open phpMyAdmin from your account panel (Databases &rsaquo; phpMyAdmin), or <a href="', $h(KEEL_PMA_INDEX . '?server=2'), '">sign in with a database user</a>.</p>',
        '</main></body></html>';
    exit;
}

$token = isset($_GET['_keel']) ? (string) $_GET['_keel'] : '';

if ($token === '') {
    // phpMyAdmin lands here after a logout or a failed signon; its error, if
    // any, sits in the signon session.
    keel_pma_start_session();
    $error = isset($_SESSION['PMA_single_signon_error_message']) ? (string) $_SESSION['PMA_single_signon_error_message'] : '';
    unset($_SESSION['PMA_single_signon_error_message'], $_SESSION['PMA_single_signon_user'], $_SESSION['PMA_single_signon_password'], $_SESSION['PMA_single_signon_host']);
    session_write_close();
    keel_pma_page(200, 'phpMyAdmin', $error !== '' ? strip_tags($error) : 'You are signed out of phpMyAdmin.');
}

if (!preg_match(KEEL_TOKEN_RE, $token)) {
    keel_pma_page(400, 'Invalid sign-on link', 'This link is not a valid phpMyAdmin sign-on link.');
}

$cred = keel_pma_exchange($token);
if (!is_array($cred)) {
    $messages = [
        'token_invalid' => 'This sign-on link is invalid, has already been used or has expired. Links are valid for one minute and can be used once.',
        'sso_disabled' => 'Single sign-on into phpMyAdmin is switched off on this server.',
        'panel_unreachable' => 'The account panel could not be reached from the web server; ask your hosting provider.',
        'curl_missing' => 'The web server cannot talk to the account panel (php-curl is missing); ask your hosting provider.',
        'endpoint_invalid' => 'The sign-on endpoint is misconfigured; ask your hosting provider.',
    ];
    $status = $cred === 'token_invalid' ? 403 : ($cred === 'sso_disabled' ? 409 : 502);
    keel_pma_page($status, 'Could not sign you in', $messages[$cred] ?? 'The account panel refused the sign-on; ask your hosting provider.');
}

keel_pma_start_session();
session_regenerate_id(true);
$_SESSION = [];
$_SESSION['PMA_single_signon_user'] = $cred['user'];
$_SESSION['PMA_single_signon_password'] = $cred['password'];
$_SESSION['PMA_single_signon_host'] = $cred['host'];
session_write_close();

header('Cache-Control: no-store');
header('Location: ' . KEEL_PMA_INDEX . '?server=1', true, 302);
exit;
