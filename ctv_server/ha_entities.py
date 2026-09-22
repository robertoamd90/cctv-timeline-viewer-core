"""Minimal, admin-only discovery data for the event entity picker."""
import re
from ctv_server.ha_client import get_json


def list_event_entities():
    states = get_json('/states')
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
