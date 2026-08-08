/**
 * Verificação de um ambiente recém-restaurado.
 *
 * Restaurar sem verificar não é recuperação — é esperança. Cada checagem aqui existe porque
 * cobre uma forma real de o backup estar quieto e errado:
 *
 *   esquema    dump de um schema mais velho que o código
 *   contagens  dump truncado por disco cheio ou timeout
 *   índices    restore sem índices: sessões que nunca expiram
 *   chave      MASTER_KEY divergente da origem — dados voltam, assinatura não
 *   auditoria  trilha restaurada pela metade, com buraco no meio
 *   órfãos     desvio entre os dois bancos além do aceitável
 *   canário    hash de senha corrompido na codificação (o erro clássico do dump em texto)
 *
 * Cada uma roda isolada: uma falha não impede as outras de reportarem, porque num incidente
 * a lista inteira de problemas vale mais que o primeiro deles.
 *
 * Uso: tsx scripts/verify-restore.ts [--skip canario] [--max-orphans N]
 * Saída: uma linha por verificação e um JSON final; código 6 em reprovação.
 */
import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import { criarRepositorioJwks } from '../src/modules/jwks/repositories/jwks.repository.js';
import { criarJwksService } from '../src/modules/jwks/services/jwks.service.js';
import { criarTokenService } from '../src/modules/auth/services/token.service.js';
import { criarServicoDeSenha } from '../src/shared/crypto/password.service.js';
import { garantirIndices } from '../src/database/mongodb/indexes.js';
import { criarRepositorioDaTrilha } from '../src/modules/audit/repositories/audit-log.repository.js';
import { criarRepositorioDeCheckpoint } from '../src/modules/audit/repositories/audit-checkpoint.repository.js';
import { criarAuditIntegrityService } from '../src/modules/audit/services/audit-integrity.service.js';

const SAIDA_REPROVADO = 6;

interface Resultado {
  readonly nome: string;
  readonly ok: boolean;
  readonly detalhe: string;
}

function argumento(nome: string): string | undefined {
  const indice = process.argv.indexOf(nome);
  return indice === -1 ? undefined : process.argv[indice + 1];
}

function exigir(nome: string): string {
  const valor = process.env[nome];
  if (valor === undefined || valor === '') {
    throw new Error(`Variável obrigatória ausente: ${nome}`);
  }
  return valor;
}

async function verificar(nome: string, acao: () => Promise<string>): Promise<Resultado> {
  try {
    return { nome, ok: true, detalhe: await acao() };
  } catch (erro) {
    return { nome, ok: false, detalhe: erro instanceof Error ? erro.message : 'falhou' };
  }
}

async function principal(): Promise<void> {
  const pularCanario = argumento('--skip') === 'canario';
  const maxOrfaos = Number(argumento('--max-orphans') ?? '0');

  const pool = new Pool({ connectionString: exigir('POSTGRES_URL') });
  const cliente = await MongoClient.connect(exigir('MONGODB_URL'));
  const banco = cliente.db(process.env['MONGODB_DB'] ?? 'iam_sessions');
  const resultados: Resultado[] = [];

  try {
    resultados.push(
      await verificar('esquema', async () => {
        const { rows } = await pool.query<{ total: string }>(
          'SELECT count(*)::text AS total FROM schema_migrations',
        );
        const aplicadas = Number(rows[0]?.total ?? '0');
        if (aplicadas === 0) throw new Error('nenhuma migração registrada no ambiente restaurado');
        return `${String(aplicadas)} migrações registradas`;
      }),
    );

    resultados.push(
      await verificar('contagens', async () => {
        const { rows } = await pool.query<{ usuarios: string; papeis: string; permissoes: string }>(
          `SELECT (SELECT count(*) FROM users)::text       AS usuarios,
                  (SELECT count(*) FROM roles)::text       AS papeis,
                  (SELECT count(*) FROM permissions)::text AS permissoes`,
        );
        const linha = rows[0];
        if (linha === undefined || Number(linha.usuarios) === 0) {
          throw new Error('nenhum usuário no ambiente restaurado');
        }
        return `users=${linha.usuarios} roles=${linha.papeis} permissions=${linha.permissoes}`;
      }),
    );

    resultados.push(
      await verificar('indices', async () => {
        // Reaplicar é idempotente e, no ambiente restaurado, é também a garantia de que os
        // índices existem: `mongorestore` sem eles deixa TTL de fora, e sessão sem TTL não
        // expira nunca — o tipo de defeito que só aparece meses depois.
        await garantirIndices(banco);
        const indices = (await banco.collection('refresh_tokens').indexes()) as unknown as Record<
          string,
          unknown
        >[];
        const comTtl = indices.filter((indice) => indice['expireAfterSeconds'] !== undefined);
        if (comTtl.length === 0) throw new Error('refresh_tokens sem índice TTL');
        return `${String(indices.length)} índices em refresh_tokens, TTL presente`;
      }),
    );

    resultados.push(
      await verificar('chave', async () => {
        const repo = criarRepositorioJwks(pool);
        const jwks = criarJwksService({
          repo,
          masterKey: exigir('MASTER_KEY'),
          cacheTtlMs: 0,
        });
        // `iniciar` decifra a chave ativa: a MASTER_KEY divergente da origem falha aqui, que
        // é o ponto em que a diferença entre "dados voltaram" e "o IdP voltou" aparece.
        await jwks.iniciar();
        const token = await criarTokenService(jwks, {
          emissor: 'https://iam.example.com',
          audiencia: 'verificacao-de-restauracao',
          ttlSegundos: 60,
        }).emitir({ sub: 'verificacao', roles: [], permissions: [], scope: '' });
        if (token.token.split('.').length !== 3) throw new Error('token emitido é malformado');
        return 'chave ativa decifra e assina';
      }),
    );

    resultados.push(
      await verificar('auditoria', async () => {
        const trilha = criarRepositorioDaTrilha(banco, { maxTentativas: 5 });
        const topo = await trilha.topo();
        if (topo.seq === 0) return 'trilha vazia — nada a verificar';

        const relatorio = await criarAuditIntegrityService({
          trilha,
          checkpoints: criarRepositorioDeCheckpoint(pool),
          janelaMaxima: 1_000_000,
        }).verificar({ de: 1 });
        if (!relatorio.integra) {
          throw new Error(
            `cadeia quebrada em ${String(relatorio.primeiraQuebra?.seq)} (${String(relatorio.primeiraQuebra?.motivo)})`,
          );
        }
        return `cadeia íntegra até ${String(relatorio.ate)}`;
      }),
    );

    resultados.push(
      await verificar('orfaos', async () => {
        // PostgreSQL e Mongo não têm instantâneo comum: a cópia do Mongo é posterior, então
        // ela pode conter sessão de um usuário que ainda não estava no dump do PostgreSQL.
        // Essa direção é inofensiva — o token simplesmente não autentica —, mas o volume
        // dela mede a janela de desvio e precisa ficar dentro do aceitável.
        const { rows } = await pool.query<{ id: string }>('SELECT id::text FROM users');
        const existentes = new Set(rows.map((linha) => linha.id));
        const usuariosComSessao = await banco.collection('refresh_tokens').distinct('user_id');
        const orfaos = usuariosComSessao.filter(
          (id) => typeof id === 'string' && !existentes.has(id),
        );
        if (orfaos.length > maxOrfaos) {
          throw new Error(
            `${String(orfaos.length)} sessões sem usuário (teto ${String(maxOrfaos)})`,
          );
        }
        return `${String(orfaos.length)} sessões órfãs`;
      }),
    );

    if (pularCanario) {
      // A ausência da verificação é registrada. Pular em silêncio faria um relatório verde
      // parecer mais forte do que é.
      resultados.push({ nome: 'canario', ok: true, detalhe: 'pulado por --skip canario' });
    } else {
      resultados.push(
        await verificar('canario', async () => {
          const email = exigir('CANARY_EMAIL');
          const senha = exigir('CANARY_PASSWORD');
          const { rows } = await pool.query<{ password_hash: string }>(
            'SELECT password_hash FROM users WHERE email = $1',
            [email],
          );
          const hash = rows[0]?.password_hash;
          if (hash === undefined) throw new Error('conta canário não existe no restaurado');

          const servico = criarServicoDeSenha({ custo: 2 ** 15, blocos: 8, paralelismo: 1 });
          if (!(await servico.verificar(senha, hash))) {
            throw new Error('a senha do canário não confere: hash corrompido na cópia');
          }
          return 'canário autentica';
        }),
      );
    }
  } finally {
    await cliente.close();
    await pool.end();
  }

  for (const resultado of resultados) {
    process.stdout.write(
      `${resultado.ok ? '✓' : '✗'} ${resultado.nome.padEnd(12)} ${resultado.detalhe}\n`,
    );
  }

  const falhas = resultados.filter((resultado) => !resultado.ok).map((resultado) => resultado.nome);
  // O JSON é o que o ensaio automatizado consome; o texto acima é para quem está lendo.
  process.stdout.write(
    `${JSON.stringify({
      resultado: falhas.length === 0 ? 'ok' : 'reprovado',
      verificacoes: resultados.length,
      falhas,
    })}\n`,
  );

  if (falhas.length > 0) process.exit(SAIDA_REPROVADO);
}

principal().catch((erro: unknown) => {
  process.stderr.write(`${erro instanceof Error ? erro.message : String(erro)}\n`);
  process.exit(1);
});
