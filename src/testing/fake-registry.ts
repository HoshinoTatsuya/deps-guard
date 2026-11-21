import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { Socket } from 'node:net';

/**
 * Поддельный реестр на 127.0.0.1: отдаёт заданные документы по пути,
 * `hang` — никогда не отвечает (проверка потолка запроса). Закрытие рвёт
 * висящие соединения, иначе `close` ждал бы их вечно.
 */
export class FakeRegistry {
  public readonly requests: Array<{ url: string; headers: IncomingHttpHeaders }> = [];

  private readonly sockets = new Set<Socket>();

  private constructor(private readonly server: Server) {}

  public static async start(
    documents: Readonly<Record<string, unknown>>,
    hang: readonly string[] = [],
  ): Promise<FakeRegistry> {
    let registry: FakeRegistry | undefined;
    const server = createServer((request, response) => {
      registry?.requests.push({ url: request.url ?? '', headers: request.headers });
      const path = request.url ?? '';
      if (hang.includes(path)) {
        return;
      }
      const document = documents[path];
      if (document === undefined) {
        response.writeHead(404).end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(document));
    });
    registry = new FakeRegistry(server);
    server.on('connection', (socket) => {
      registry?.sockets.add(socket);
      socket.on('close', () => registry?.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return registry;
  }

  public get url(): string {
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('сервер не слушает');
    }
    return `http://127.0.0.1:${address.port}/`;
  }

  public async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
