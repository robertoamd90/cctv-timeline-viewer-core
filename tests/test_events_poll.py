import asyncio
import json
import threading
import unittest
from starlette.requests import Request
from ctv_server.api import events
from ctv_server.auth import CurrentUser
from ctv_server.lifecycle import stopping


class EventPollTests(unittest.TestCase):
    def request(self, admin=True):
        async def receive():
            await asyncio.Event().wait()
        request = Request({'type': 'http', 'headers': []}, receive)
        request.state.ctv_user = CurrentUser('test', 'Test', 'Test', admin, True)
        return request

    def poll(self, cursor=None, admin=True):
        response = events.poll_events(self.request(admin), cursor)
        self.assertEqual(int(response.headers['content-length']), len(response.body))
        self.assertLess(len(response.body), 300000)
        return json.loads(response.body)

    def test_replay_sanitization_and_invalid_cursors(self):
        cursor = self.poll()['cursor']
        payload = {'path': '/secret', 'error': '/secret failed', 'camera_id': 2}
        events.emit('scan', payload)
        payload['camera_id'] = 99
        result = self.poll(cursor, admin=False)
        self.assertEqual(result['events'], [{'type':'scan', 'data':{'error':'Source unavailable', 'camera_id':2}}])
        self.assertFalse(result['more'])
        self.assertEqual(self.poll(result['cursor'])['events'], [])
        for cursor in ['bad', 'other:0', f'{events._epoch}:999999999']:
            self.assertTrue(self.poll(cursor)['reset'])

    def test_bounded_batches_and_history_gap(self):
        cursor = self.poll()['cursor']
        for index in range(140):
            events.emit('scan', {'index': index})
        first = self.poll(cursor)
        self.assertEqual(len(first['events']), 128)
        self.assertTrue(first['more'])
        second = self.poll(first['cursor'])
        self.assertEqual(len(second['events']), 12)
        self.assertFalse(second['more'])
        for index in range(1025):
            events.emit('scan', {'index': index})
        self.assertTrue(self.poll(cursor)['reset'])
        cursor = self.poll()['cursor']
        events.emit('scan', {'data': 'x' * 300000})
        self.assertTrue(self.poll(cursor)['reset'])

    def test_worker_thread_delivers_to_sse_and_cleans_listener(self):
        async def exercise():
            stopping.clear()
            stream = events._event_stream(self.request())
            self.assertIn('connected', await anext(stream))
            worker = threading.Thread(target=events.emit, args=('scan', {'ok':True}))
            worker.start()
            self.assertIn('"ok": true', await asyncio.wait_for(anext(stream), 0.5))
            worker.join()
            await stream.aclose()
            self.assertEqual(events._listeners, [])
        asyncio.run(exercise())
