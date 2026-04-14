#!/bin/sh
set -e

NGINX_USER=${NGINX_USER:-admin}
NGINX_PASS=${NGINX_PASS:-admin}

htpasswd -bc /etc/nginx/.htpasswd "$NGINX_USER" "$NGINX_PASS"

exec "$@"
