"""Local-only streaming shaper for synthetic playback tests.
Usage: python scripts/playback_test_proxy.py http://127.0.0.1:8765 8775
POST /__network accepts bytes_per_second and pause_seconds. Do not expose this
utility outside localhost or use it against a production archive.
"""
import asyncio, time, sys
from urllib.parse import urlparse
import httpx, uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, Response
app=FastAPI()
client=httpx.AsyncClient(timeout=None)
origin=sys.argv[1]
if urlparse(origin).hostname not in ('127.0.0.1','localhost','::1'):
 raise SystemExit('Local synthetic fixture servers only')
ingress='--ingress' in sys.argv[3:]
ingress_path='api/hassio_ingress/synthetic-fixture/'
rate=300000
next_send=0
paused_until=0
lock=asyncio.Lock()
@app.post('/__network')
async def network(request:Request):
 global rate, paused_until, next_send
 data=await request.json()
 rate=data.get('bytes_per_second',rate)
 paused_until=time.monotonic()+data.get('pause_seconds',0)
 next_send=time.monotonic()
 return {'rate':rate,'pause_seconds':data.get('pause_seconds',0)}
@app.api_route('/{path:path}',methods=['GET','POST','PUT','DELETE'])
async def proxy(path:str,request:Request):
 global next_send
 if ingress:
  if not path.startswith(ingress_path):
   return Response(status_code=404)
  path=path[len(ingress_path):]
 headers={k:v for k,v in request.headers.items() if k.lower() not in ('host','accept-encoding','connection')}
 headers['accept-encoding']='identity'
 if ingress:
  headers['X-Remote-User-Id']='fixture-user'
  headers['X-Remote-User-Name']='Synthetic fixture'
  headers['X-Ingress-Path']='/'+ingress_path
 req=client.build_request(request.method,origin+'/'+path+('?' + request.url.query if request.url.query else ''),headers=headers,content=await request.body())
 response=await client.send(req,stream=True)
 # Match Supervisor's documented small-response buffering threshold. This
 # remains a simulation; it does not run the real Supervisor implementation.
 if ingress and response.headers.get('Content-Length') and int(response.headers['Content-Length'])<4194000:
  content=await response.aread()
  await response.aclose()
  # Shaping below still applies to buffered media before delivering it.
  async def buffered_body():
   yield content
  chunks=buffered_body()
 else:
  chunks=response.aiter_raw(chunk_size=16384)
 media=path.startswith(('stream/','video/','hls/'))
 async def body():
  global next_send
  try:
   async for chunk in chunks:
    if media and rate:
     async with lock:
      next_send=max(time.monotonic(),next_send)+len(chunk)/rate
      ready=next_send
     await asyncio.sleep(max(0,ready-time.monotonic()))
    while time.monotonic()<paused_until:
     await asyncio.sleep(min(0.1,max(0,paused_until-time.monotonic())))
    yield chunk
  finally:
   await response.aclose()
 result_headers={k:v for k,v in response.headers.items() if k.lower() not in ('transfer-encoding','connection')}
 return StreamingResponse(body(),status_code=response.status_code,headers=result_headers)
if __name__=='__main__':uvicorn.run(app,host='127.0.0.1',port=int(sys.argv[2]),log_level='warning')
