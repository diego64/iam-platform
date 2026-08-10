/**
 * Responsabilidade: lembrar de que dispositivos um usuário já entrou, para que só a primeira
 * aparição gere aviso.
 * Consumido por: o serviço de notificação, no caminho do login.
 * Regras:
 *  - **O `upsert` é a detecção.** Inseriu ⇒ dispositivo novo. Nenhuma leitura antes: duas
 *    entradas simultâneas do mesmo dispositivo produziriam dois "é novo" se a decisão fosse
 *    ler-e-depois-escrever.
 *  - **TTL deslizante.** `expires_at` é regravado a cada aparição. Com janela fixa, quem usa
 *    o mesmo navegador todo dia receberia um "novo dispositivo" falso a cada vencimento — e
 *    aviso que chega sem motivo ensina a ignorar o que chega com motivo.
 *  - **Falha de I/O não notifica.** É o oposto do fail open do resto da plataforma, e é
 *    deliberado: um Mongo fora transformaria todo login em e-mail, justo quando o operador
 *    já tem um incidente nas mãos.
 *  - O documento guarda só o digest. Sem `user_id`: listar "os dispositivos de fulano" é
 *    feature de outra SPEC, e sem o campo a coleção não vira rastro de comportamento.
 */
import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';

const COLECAO = 'known_devices';

export interface DispositivoObservado {
  readonly userId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface RepositorioDeDispositivos {
  /**
   * Registra a aparição e devolve `true` só na primeira.
   * `false` também quando o banco falhou ou quando não há como identificar o dispositivo.
   */
  ehNovo(dispositivo: DispositivoObservado): Promise<boolean>;
}

interface LinhaMongo {
  readonly _id: string;
  readonly primeiro_uso: Date;
  readonly ultimo_uso: Date;
  readonly expires_at: Date;
}

export interface OpcoesDeDispositivos {
  readonly banco: Db;
  /** Por quanto tempo o dispositivo continua conhecido depois do último uso. */
  readonly ttlMs: number;
  /** Impede reverter o digest por dicionário de user-agents comuns. */
  readonly pepper: string;
  readonly aoFalhar?: (erro: unknown) => void;
}

/**
 * A rede de origem, e não o endereço exato.
 *
 * O IP inteiro trocaria de valor a cada salto de NAT móvel e encheria a caixa de entrada de
 * quem só andou de ônibus; o prefixo continua distinguindo o acesso vindo de outra operadora,
 * de outro país ou de outro datacenter, que é o que o aviso existe para pegar.
 */
export function prefixoDeRede(ip: string): string {
  const limpo = ip.trim().toLowerCase();
  // IPv4 mapeado em IPv6 (`::ffff:203.0.113.10`) é IPv4 para todos os efeitos aqui.
  const semMapeamento = limpo.startsWith('::ffff:') ? limpo.slice('::ffff:'.length) : limpo;

  if (semMapeamento.includes('.')) {
    const octetos = semMapeamento.split('.');
    return octetos.length === 4 ? octetos.slice(0, 3).join('.') : semMapeamento;
  }

  // IPv6: /48 são os três primeiros grupos. Endereço abreviado (`2001:db8::1`) tem menos de
  // três grupos antes do `::`, e aí o que existe já é o prefixo.
  return semMapeamento.split(':').slice(0, 3).join(':');
}

export function criarRepositorioDeDispositivos(
  opcoes: OpcoesDeDispositivos,
): RepositorioDeDispositivos {
  const colecao = opcoes.banco.collection<LinhaMongo>(COLECAO);

  function digest(dispositivo: DispositivoObservado): string {
    const rede = dispositivo.ip === null ? '' : prefixoDeRede(dispositivo.ip);
    return createHash('sha256')
      .update(
        `${dispositivo.userId}:${dispositivo.userAgent ?? ''}:${rede}:${opcoes.pepper}`,
        'utf8',
      )
      .digest('hex');
  }

  return {
    async ehNovo(dispositivo: DispositivoObservado): Promise<boolean> {
      // Sem user-agent e sem IP não há dispositivo a distinguir: todo login por script cairia
      // no mesmo balde, e avisar por causa dele seria um e-mail por execução.
      if (dispositivo.userAgent === null && dispositivo.ip === null) return false;

      const agora = new Date();
      try {
        const resultado = await colecao.updateOne(
          { _id: digest(dispositivo) },
          {
            $set: { ultimo_uso: agora, expires_at: new Date(agora.getTime() + opcoes.ttlMs) },
            $setOnInsert: { primeiro_uso: agora },
          },
          { upsert: true },
        );

        return resultado.upsertedCount === 1;
      } catch (erro) {
        opcoes.aoFalhar?.(erro);
        return false;
      }
    },
  };
}
