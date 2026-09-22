"""Minimal, admin-only discovery data for the event entity picker."""
import json
import os
import re
from urllib.request import Request, urlopen


def list_event_entities():
    token = os.environ.get('SUPERVISOR_TOKEN')
    if not token:
        raise RuntimeError('Home Assistant unavailable')
    request = Request('http://supervisor/core/api/states',
                      headers={'Authorization': f'Bearer {token}'})
    with urlopen(request, timeout=10) as response:
        raw = response.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError('Response too large')
    states = json.loads(raw)
    if not isinstance(states, list):
        raise ValueError('Invalid response')
    entities = {}
    for item in states:
        entity = item.get('entity_id', '')
        if not re.fullmatch(r'binary_sensor\.[a-z0-9_]+', entity):
            continue
        attrs = item.get('attributes') or {}
        entities[entity] = {'entity_id': entity,
                            'name': str(attrs.get('friendly_name') or entity)[:255],
                            'state': str(item.get('state', 'unknown'))[:64]}
    return sorted(entities.values(), key=lambda item: (item['name'].casefold(), item['entity_id']))
