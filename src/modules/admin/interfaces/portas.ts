/**
 * Responsabilidade: o que o painel administrativo precisa ler dos outros módulos, declarado
 * como porta.
 * Consumido por: os serviços de agregação; o concreto de cada porta é montado na fiação.
 * Regras:
 *  - Este módulo agrega, não é dono de dado nenhum: não tem tabela, não tem repositório e
 *    não conhece `pg` nem `mongodb`.
 *  - Cada porta pede o mínimo. Uma porta que devolvesse a entidade inteira arrastaria para
 *    cá campos que a resposta administrativa não pode expor — hash de senha, hash de token,
 *    segredo de cliente — e a proteção passaria a depender de lembrar de removê-los.
 */
import type { StatusDeUsuario } from '../../users/entities/user.entity.js';

export interface PerfilDeUsuario {
  readonly id: string;
  readonly email: string;
  readonly status: StatusDeUsuario;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}

export interface PapelDoUsuario {
  readonly id: string;
  readonly name: string;
  readonly isSystem: boolean;
}

export interface SessaoDeUsuario {
  readonly sessionId: string;
  readonly criadaEm: Date;
  readonly expiraEm: Date;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly vistaPorUltimoEm?: Date;
}

export interface EventoResumido {
  readonly seq: number;
  readonly type: string;
  readonly occurredAt: Date;
  readonly outcome: string;
}

export interface ChaveAtiva {
  readonly kid: string;
  readonly criadaEm: Date;
}

export interface LeitorDeUsuarios {
  contarPorStatus(): Promise<Record<StatusDeUsuario, number>>;
  buscarPorId(id: string): Promise<PerfilDeUsuario | null>;
}

export interface LeitorDeAutorizacao {
  papeisDoUsuario(userId: string): Promise<PapelDoUsuario[]>;
  permissoesEfetivas(userId: string): Promise<string[]>;
}

export interface LeitorDeSessoes {
  listarDoUsuario(userId: string): Promise<SessaoDeUsuario[]>;
  contarAtivas(): Promise<number>;
}

export interface RevogadorDeSessoesDeTerceiro {
  /** `false` quando a sessão não existe ou não pertence ao usuário — nunca revoga cruzado. */
  revogarUma(userId: string, sessionId: string): Promise<boolean>;
  /** Quantas sessões caíram. É a única confirmação de efeito que o administrador tem. */
  revogarTodas(userId: string): Promise<number>;
}

export interface LeitorDeAuditoria {
  ultimosDoUsuario(userId: string, limite: number): Promise<EventoResumido[]>;
  contarPorTipoDesde(tipo: string, desde: Date): Promise<number>;
}

export interface LeitorDeClientes {
  contarAtivos(): Promise<number>;
}

export interface LeitorDeChaveAtiva {
  obter(): Promise<ChaveAtiva | null>;
}

export interface LeitorDeSenha {
  /** Instante da última troca registrada, ou `null` para quem nunca trocou. */
  alteradaEm(userId: string): Promise<Date | null>;
}
