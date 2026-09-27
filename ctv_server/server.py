"""Signal-aware production entrypoint: stop producers before draining HTTP."""
import uvicorn

from ctv_server.lifecycle import stopping


class Server(uvicorn.Server):
    def handle_exit(self, sig, frame):
        stopping.set()
        super().handle_exit(sig, frame)


def main():
    Server(uvicorn.Config('ctv_server.main:app', host='0.0.0.0', port=8000,
                          proxy_headers=False, timeout_graceful_shutdown=5)).run()


if __name__ == '__main__':
    main()
