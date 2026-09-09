"""Local-only streaming shaper for synthetic playback tests.
Usage: python scripts/playback_test_proxy.py http://127.0.0.1:8765 8775
POST /__network accepts bytes_per_second and pause_seconds. Do not expose this
utility outside localhost or use it against a production archive.
"""
import asyncio, time, sys
import httpx, uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, Response
app=FastAPI()
client=httpx.AsyncClient(timeout=None)
origin=sys.argv[1]
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
 headers={k:v for k,v in request.headers.items() if k.lower() not in ('host','accept-encoding','connection')}
 headers['accept-encoding']='identity'
 req=client.build_request(request.method,origin+'/'+path+('?' + request.url.query if request.url.query else ''),headers=headers,content=await request.body())
 response=await client.send(req,stream=True)
 media=path.startswith(('stream/','video/','hls/'))
 async def body():
  global next_send
  try:
   async for chunk in response.aiter_raw(chunk_size=16384 if media else None):
    if media and rate:
     async with lock:
      next_send=max(time.monotonic(),next_send)+len(chunk)/rate
      ready=next_send
     await asyncio.sleep(max(0,ready-time.monotonic()))
     while time.monotonic()<paused_until:
      await asyncio.sleep(min(0.1,paused_until-time.monotonic()))
    yield chunk
  finally:
   await response.aclose()
 result_headers={k:v for k,v in response.headers.items() if k.lower() not in ('transfer-encoding','connection')}
 return StreamingResponse(body(),status_code=response.status_code,headers=result_headers)
if __name__=='__main__':uvicorn.run(app,host='127.0.0.1',port=int(sys.argv[2]),log_level='warning')
