#!/bin/bash
# Keel PHP source build. Static: every parameter arrives through the
# environment set by pkg.php.build (agent/src/ops/pkg.js); nothing is ever
# interpolated into this file.
#   KEEL_PHP_SRC     extracted php-<version> source directory
#   KEEL_PHP_PREFIX  install prefix, /opt/keel/php/<minor>
#   KEEL_PHP_MINOR   the minor being built (informational)
#   KEEL_PHP_JOBS    make -j value
#   KEEL_FPM_USER    compiled-in default FPM user
#   KEEL_FPM_GROUP   compiled-in default FPM group
set -euo pipefail

for v in KEEL_PHP_SRC KEEL_PHP_PREFIX KEEL_PHP_MINOR KEEL_PHP_JOBS KEEL_FPM_USER KEEL_FPM_GROUP; do
  if [ -z "${!v:-}" ]; then echo "php-build: $v is not set" >&2; exit 64; fi
done
case "$KEEL_PHP_PREFIX" in /opt/keel/php/*) ;; *) echo "php-build: refusing prefix $KEEL_PHP_PREFIX outside /opt/keel/php" >&2; exit 64 ;; esac
case "$KEEL_PHP_JOBS" in ''|*[!0-9]*) echo "php-build: KEEL_PHP_JOBS must be a number" >&2; exit 64 ;; esac

# A make install that dies half-way must not leave a prefix the panel would
# list as an installed version: a prefix this run created is removed on any
# failure, and .keel-build-ok (written last) is what discovery looks for.
fresh=0
[ -e "$KEEL_PHP_PREFIX/bin/php" ] || fresh=1
rm -f "$KEEL_PHP_PREFIX/.keel-build-ok"
trap 'rc=$?; if [ $rc -ne 0 ] && [ $fresh = 1 ]; then rm -rf -- "$KEEL_PHP_PREFIX"; fi; exit $rc' EXIT

cd "$KEEL_PHP_SRC"
echo "== configure PHP" "$KEEL_PHP_MINOR" "for" "$KEEL_PHP_PREFIX" "($KEEL_PHP_JOBS jobs)"
./configure \
  --prefix="$KEEL_PHP_PREFIX" \
  --with-config-file-path="$KEEL_PHP_PREFIX/lib" \
  --with-config-file-scan-dir="$KEEL_PHP_PREFIX/lib/conf.d" \
  --enable-fpm \
  --with-fpm-user="$KEEL_FPM_USER" \
  --with-fpm-group="$KEEL_FPM_GROUP" \
  --with-openssl \
  --with-zlib \
  --with-curl \
  --enable-mbstring \
  --with-mysqli=mysqlnd \
  --with-pdo-mysql=mysqlnd \
  --with-mysql-sock=/var/run/mysqld/mysqld.sock \
  --with-pdo-sqlite \
  --with-sqlite3 \
  --enable-intl \
  --with-zip \
  --enable-gd \
  --with-jpeg \
  --with-webp \
  --with-freetype \
  --enable-bcmath \
  --enable-soap \
  --with-sodium \
  --with-readline \
  --with-xsl \
  --with-gmp \
  --with-bz2 \
  --enable-opcache \
  --enable-exif \
  --enable-pcntl \
  --enable-sockets \
  --with-ffi \
  --enable-calendar

echo "== make -j$KEEL_PHP_JOBS"
make -j"$KEEL_PHP_JOBS"

echo "== make install"
make install

echo "== configuration under $KEEL_PHP_PREFIX"
install -m 0644 php.ini-production "$KEEL_PHP_PREFIX/lib/php.ini"
mkdir -p "$KEEL_PHP_PREFIX/lib/conf.d" "$KEEL_PHP_PREFIX/etc/php-fpm.d" "$KEEL_PHP_PREFIX/var/log" "$KEEL_PHP_PREFIX/var/run"
printf 'zend_extension=opcache\n' > "$KEEL_PHP_PREFIX/lib/conf.d/10-opcache.ini"

# php-fpm refuses to start without a pool; the idle pool keeps the unit up
# until the panel writes the first whm-<user>.conf. Pools are per account, so
# no www.conf is created.
fpmconf="$KEEL_PHP_PREFIX/etc/php-fpm.conf"
{
  echo '; Written by Keel (pkg.php.build); per-account pools live in etc/php-fpm.d/whm-<user>.conf'
  echo '[global]'
  echo "pid = $KEEL_PHP_PREFIX/var/run/php-fpm.pid"
  echo "error_log = $KEEL_PHP_PREFIX/var/log/php-fpm.log"
  echo 'daemonize = no'
  echo "include = $KEEL_PHP_PREFIX/etc/php-fpm.d/*.conf"
} > "$fpmconf.tmp"
mv "$fpmconf.tmp" "$fpmconf"
idle="$KEEL_PHP_PREFIX/etc/php-fpm.d/keel-idle.conf"
{
  echo '; Written by Keel (pkg.php.build): placeholder pool so the service can run with no account pools'
  echo '[keel-idle]'
  echo "user = $KEEL_FPM_USER"
  echo "group = $KEEL_FPM_GROUP"
  echo "listen = /run/keel-php/php$KEEL_PHP_MINOR-fpm-keel-idle.sock"
  echo 'listen.mode = 0600'
  echo 'pm = ondemand'
  echo 'pm.max_children = 1'
} > "$idle.tmp"
mv "$idle.tmp" "$idle"
rm -f "$KEEL_PHP_PREFIX/etc/php-fpm.d/www.conf"

"$KEEL_PHP_PREFIX/bin/php" -n -r 'echo "== built PHP ", PHP_VERSION, "\n";'
"$KEEL_PHP_PREFIX/sbin/php-fpm" -t --fpm-config "$fpmconf"
: > "$KEEL_PHP_PREFIX/.keel-build-ok"
