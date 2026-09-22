import json
import socket
import unittest
from unittest.mock import MagicMock, patch
from ctv_server.ha_client import get_json, HAError


class HAClientTests(unittest.TestCase):
    def connection(self, status=200, payload=b'[]'):
        connection = MagicMock()
        connection.getresponse.return_value.status = status
        connection.getresponse.return_value.read.return_value = payload
        return connection

    def test_internal_http_needs_no_tls_or_environment_proxy(self):
        connection = self.connection()
        with patch.dict('os.environ', {'SUPERVISOR_TOKEN':'secret', 'http_proxy':'http://invalid:99'}), \
             patch('ssl._create_default_https_context', side_effect=PermissionError), \
             patch('ctv_server.ha_client.http.client.HTTPConnection', return_value=connection) as factory:
            self.assertEqual(get_json('/states'), [])
        factory.assert_called_once_with('supervisor',80,timeout=10)
        args = connection.request.call_args
        self.assertEqual(args.args, ('GET','/core/api/states'))
        self.assertEqual(args.kwargs['headers']['Authorization'], 'Bearer secret')
        connection.close.assert_called_once()

    def test_http_errors_and_redirects_are_not_followed(self):
        for status, code in [(401,'unauthorized'),(403,'unauthorized'),(502,'http_error'),(302,'http_error')]:
            connection = self.connection(status)
            with patch.dict('os.environ',{'SUPERVISOR_TOKEN':'secret'}), patch('ctv_server.ha_client.http.client.HTTPConnection',return_value=connection):
                with self.assertRaises(HAError) as error:
                    get_json('/states')
            self.assertEqual(error.exception.code,code)
            self.assertEqual(error.exception.status,status)
            connection.close.assert_called_once()
            connection.getresponse.return_value.read.assert_not_called()

    def test_network_errors_are_safe_and_actionable(self):
        for exc, code in [(socket.gaierror('secret'),'dns_error'),(TimeoutError('secret'),'timeout'),(PermissionError('secret'),'permission_denied'),(ConnectionRefusedError('secret'),'connection_error')]:
            connection = self.connection()
            connection.request.side_effect=exc
            with patch.dict('os.environ',{'SUPERVISOR_TOKEN':'secret'}), patch('ctv_server.ha_client.http.client.HTTPConnection',return_value=connection):
                with self.assertRaises(HAError) as error:
                    get_json('/states')
            self.assertEqual(str(error.exception),code)
            connection.close.assert_called_once()

    def test_bad_or_oversized_payload(self):
        for payload, code in [(b'<html>','invalid_response'),(b'{}','invalid_response'),(b'x'*(8*1024*1024+1),'response_too_large')]:
            with patch.dict('os.environ',{'SUPERVISOR_TOKEN':'secret'}), patch('ctv_server.ha_client.http.client.HTTPConnection',return_value=self.connection(payload=payload)):
                with self.assertRaises(HAError) as error:
                    get_json('/states')
            self.assertEqual(error.exception.code,code)

    def test_real_http_serialization_and_response_parser(self):
        import http.client
        import io
        class Wire:
            def __init__(self):
                self.sent = b''
            def sendall(self, data):
                self.sent += data
            def makefile(self, *args):
                body = b'[{"entity_id":"binary_sensor.front","state":"on"}]'
                return io.BytesIO(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
            def close(self):
                pass
        wire = Wire()
        connection = http.client.HTTPConnection('supervisor',80,timeout=10)
        connection.sock = wire
        with patch.dict('os.environ',{'SUPERVISOR_TOKEN':'test-token'}), patch('ctv_server.ha_client.http.client.HTTPConnection',return_value=connection):
            result = get_json('/states')
        self.assertEqual(result[0]['entity_id'],'binary_sensor.front')
        self.assertIn(b'GET /core/api/states HTTP/1.1\r\n',wire.sent)
        self.assertIn(b'Authorization: Bearer test-token\r\n',wire.sent)
        self.assertIn(b'Content-Type: application/json\r\n',wire.sent)
