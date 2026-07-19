/**
 * Responsabilidade: bootstrap — telemetria, conexões (PG/Mongo), app.listen e graceful shutdown.
 * Regras: SIGTERM/SIGINT fecham servidor e pools na ordem inversa; timeout de shutdown de 10s.
 */
import { construirApp } from './app.js';
import { env } from './config/env.js';

async function iniciar(): Promise<void> {
  const app = await construirApp();

  await app.listen({ host: env.HOST, port: env.PORT });

  const encerrar = async (sinal: string): Promise<void> => {
    app.log.info({ sinal }, 'encerrando aplicação');
    await app.close(); // fechar pool do pg e client do mongo aqui
    process.exit(0);
  };
  process.on('SIGTERM', () => void encerrar('SIGTERM'));
  process.on('SIGINT', () => void encerrar('SIGINT'));
}

void iniciar();
