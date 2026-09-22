"""Bounded HTTP access to the fixed Supervisor Core proxy.

No environment proxies, redirects, or unnecessary TLS/certificate-store setup
for this internal HTTP endpoint. Never include tokens or response bodies in errors.
"""
import http.client
import json
import os
import socket


class HAError(RuntimeError):
    def __init__(self, code, status=None):
        super().__init__(code)
        self.code = code
        self.status = status


def get_json(path):
    token = os.environ.get('SUPERVISOR_TOKEN')
    if not token:
        raise HAError('missing_token')
    if not path.startswith('/') or '\r' in path or '\n' in path:
        raise HAError('invalid_request')
    connection = http.client.HTTPConnection('supervisor', 80, timeout=10)
    try:
        connection.request('GET', '/core/api' + path, headers={
            'Authorization': f'Bearer {token}',
            'Accept': 'application/json', 'Content-Type': 'application/json',
        })
        response = connection.getresponse()
        if response.status != 200:
            code = 'unauthorized' if response.status in (401, 403) else 'http_error'
            raise HAError(code, response.status)
        raw = response.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise HAError('response_too_large')
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError):
            raise HAError('invalid_response') from None
        if not isinstance(result, list):
            raise HAError('invalid_response')
        return result
    except HAError:
        raise
    except socket.gaierror:
        raise HAError('dns_error') from None
    except TimeoutError:
        raise HAError('timeout') from None
    except PermissionError:
        raise HAError('permission_denied') from None
    except (OSError, http.client.HTTPException):
        raise HAError('connection_error') from None
    finally:
        connection.close()
