import json
import unittest
from unittest.mock import patch, MagicMock
from fastapi import HTTPException
from ctv_server.ha_entities import list_event_entities
from ctv_server.api.system import ha_event_entities


class HaEntityDiscoveryTests(unittest.TestCase):
    def test_filters_and_returns_only_picker_fields(self):
        payload = [
            {'entity_id':'camera.front','state':'idle'},
            {'entity_id':'binary_sensor.front','state':'unavailable','attributes':{'friendly_name':'Front','secret':'hidden'}},
            {'entity_id':'binary_sensor.back','state':'off','attributes':{'friendly_name':'Back'}},
        ]
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(payload).encode()
        with patch.dict('os.environ', {'SUPERVISOR_TOKEN':'test-token'}), patch('ctv_server.ha_entities.urlopen',return_value=response):
            entities = list_event_entities()
        self.assertEqual([e['name'] for e in entities],['Back','Front'])
        self.assertEqual(set(entities[0]),{'entity_id','name','state'})
        self.assertEqual(entities[1]['state'],'unavailable')

    def test_no_credentials_and_safe_error(self):
        with patch.dict('os.environ',{},clear=True):
            with self.assertRaises(RuntimeError):
                list_event_entities()
        with patch('ctv_server.ha_entities.list_event_entities',side_effect=RuntimeError('secret-token')):
            with self.assertRaises(HTTPException) as error:
                ha_event_entities()
        self.assertEqual(error.exception.status_code,503)
        self.assertNotIn('secret-token',error.exception.detail)
