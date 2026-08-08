/**
 * Responsabilidade: cadastro, confirmação, estado, desativação e regeneração de códigos do
 * segundo fator.
 * Consumido por: o controller das rotas de MFA.
 * Regras:
 *  - O segredo só existe em claro em dois momentos: na resposta do cadastro (para o usuário
 *    ler o QR Code) e dentro da verificação, entre a decifragem e o cálculo do código. No
 *    banco ele é blob do envelope AES-256-GCM.
 *  - Cadastro pendente não protege nada. Só a confirmação — que exige um código válido, ou
 *    seja, prova de posse do dispositivo — ativa o fator.
 *  - Desativar e regenerar exigem a senha atual. Sem isso, um access token roubado
 *    desligaria o segundo fator da vítima, que é justamente o que ele existe para impedir.
 *  - Nenhum Fastify nem driver aqui: repositórios, serviço de senha e relógio por injeção.
 */
import { cifrarSegredo } from '../../../shared/crypto/key-envelope.js';
import type { ServicoDeSenha } from '../../../shared/crypto/password.service.js';
import type { Usuario } from '../../users/entities/user.entity.js';
import { ErroDeMfa } from '../errors/mfa-error.js';
import { gerarSegredo, montarUriOtpauth, validarCodigo } from './totp.js';
import { decifrarSegredoDoFator } from './secret-envelope.js';
import { QUANTIDADE_PADRAO, gerarCodigosDeRecuperacao } from './recovery-codes.js';
import type { RepositorioDeFatorDeMfa } from '../repositories/mfa-factor.repository.js';
import type { RepositorioDeCodigosDeRecuperacao } from '../repositories/recovery-code.repository.js';
import type { RepositorioDeDesafioDeMfa } from '../repositories/mfa-challenge.repository.js';

export interface LeituraDeUsuario {
  buscarPorId(id: string): Promise<Usuario | null>;
}

export interface DependenciasDoMfaService {
  readonly fatores: RepositorioDeFatorDeMfa;
  readonly codigos: RepositorioDeCodigosDeRecuperacao;
  /** Desafios abertos são descartados quando o fator muda — não sobra login pela metade. */
  readonly desafios: Pick<RepositorioDeDesafioDeMfa, 'removerDoUsuario'>;
  readonly usuarios: LeituraDeUsuario;
  readonly servicoDeSenha: ServicoDeSenha;
  /** Cifra o segredo em repouso. Sem ela o módulo não é montado. */
  readonly masterKey: string;
  /** Nome que aparece no aplicativo autenticador. */
  readonly emissor: string;
  readonly quantidadeDeCodigos?: number;
  readonly janela?: number;
}

export interface CadastroIniciado {
  readonly segredoBase32: string;
  readonly uriOtpauth: string;
}

export interface CadastroConfirmado {
  readonly confirmadoEm: Date;
  readonly codigosDeRecuperacao: readonly string[];
}

export interface EstadoDeMfa {
  readonly habilitado: boolean;
  readonly status: 'active' | 'pending' | 'none';
  readonly tipo: 'totp' | null;
  readonly confirmadoEm: Date | null;
  readonly ultimoUsoEm: Date | null;
  readonly codigosDeRecuperacaoRestantes: number;
}

export interface MfaService {
  iniciarCadastro(userId: string, label: string | null): Promise<CadastroIniciado>;
  confirmarCadastro(userId: string, codigo: string): Promise<CadastroConfirmado>;
  estado(userId: string): Promise<EstadoDeMfa>;
  desativar(userId: string, senha: string): Promise<void>;
  regenerarCodigos(userId: string, senha: string): Promise<readonly string[]>;
  /** Remove o fator de outra pessoa — o caminho administrativo para conta travada. */
  removerFator(userId: string): Promise<boolean>;
}

export function criarMfaService(deps: DependenciasDoMfaService): MfaService {
  const quantidade = deps.quantidadeDeCodigos ?? QUANTIDADE_PADRAO;

  async function exigirUsuario(userId: string): Promise<Usuario> {
    const usuario = await deps.usuarios.buscarPorId(userId);
    if (usuario === null) {
      throw new ErroDeMfa('usuario-nao-encontrado');
    }
    return usuario;
  }

  /** Step-up: confirma que quem está do outro lado sabe a senha, não só tem o token. */
  async function exigirSenha(usuario: Usuario, senha: string): Promise<void> {
    const confere = await deps.servicoDeSenha.verificar(senha, usuario.passwordHash);
    if (!confere) {
      throw new ErroDeMfa('credencial-invalida');
    }
  }

  async function emitirCodigos(userId: string): Promise<readonly string[]> {
    const { codigos, hashes } = gerarCodigosDeRecuperacao(quantidade);
    await deps.codigos.substituir(userId, hashes);
    return codigos;
  }

  return {
    async iniciarCadastro(userId, label): Promise<CadastroIniciado> {
      const usuario = await exigirUsuario(userId);
      if ((await deps.fatores.buscarAtivo(userId)) !== null) {
        // Sobrescrever em silêncio trocaria o segredo em uso por outro que o usuário ainda
        // não cadastrou em lugar nenhum — e ele descobriria no próximo login.
        throw new ErroDeMfa('ja-habilitado');
      }

      const segredo = gerarSegredo();
      await deps.fatores.criarPendente({
        userId,
        segredoCifrado: cifrarSegredo(segredo, deps.masterKey),
        label,
      });

      const uriOtpauth = montarUriOtpauth({
        segredo,
        emissor: deps.emissor,
        conta: usuario.email,
      });
      // O base32 devolvido é o mesmo da URI — para quem digita o segredo à mão, sem QR Code.
      const segredoBase32 = new URL(uriOtpauth).searchParams.get('secret') ?? '';
      return { segredoBase32, uriOtpauth };
    },

    async confirmarCadastro(userId, codigo): Promise<CadastroConfirmado> {
      const pendente = await deps.fatores.buscarPendente(userId);
      if (pendente === null) {
        throw new ErroDeMfa('cadastro-nao-encontrado');
      }

      const segredo = decifrarSegredoDoFator(pendente.segredoCifrado, deps.masterKey);
      const aceito = validarCodigo(segredo, codigo, {
        passoMinimo: pendente.ultimoPasso,
        ...(deps.janela === undefined ? {} : { janela: deps.janela }),
      });
      if (aceito === null) {
        // O fator continua pendente: errar o código não pode custar o cadastro inteiro.
        throw new ErroDeMfa('codigo-invalido');
      }

      const ativado = await deps.fatores.ativar(pendente.id, aceito.passo);
      if (!ativado) {
        throw new ErroDeMfa('cadastro-nao-encontrado');
      }

      const codigosDeRecuperacao = await emitirCodigos(userId);
      const ativo = await deps.fatores.buscarAtivo(userId);
      return {
        confirmadoEm: ativo?.confirmadoEm ?? new Date(),
        codigosDeRecuperacao,
      };
    },

    async estado(userId): Promise<EstadoDeMfa> {
      const [ativo, pendente, restantes] = await Promise.all([
        deps.fatores.buscarAtivo(userId),
        deps.fatores.buscarPendente(userId),
        deps.codigos.contarValidos(userId),
      ]);

      if (ativo !== null) {
        return {
          habilitado: true,
          status: 'active',
          tipo: 'totp',
          confirmadoEm: ativo.confirmadoEm,
          ultimoUsoEm: ativo.ultimoUsoEm,
          codigosDeRecuperacaoRestantes: restantes,
        };
      }

      return {
        habilitado: false,
        status: pendente === null ? 'none' : 'pending',
        tipo: pendente === null ? null : 'totp',
        confirmadoEm: null,
        ultimoUsoEm: null,
        codigosDeRecuperacaoRestantes: 0,
      };
    },

    async desativar(userId, senha): Promise<void> {
      const usuario = await exigirUsuario(userId);
      await exigirSenha(usuario, senha);

      const removidos = await deps.fatores.removerDoUsuario(userId);
      if (removidos === 0) {
        throw new ErroDeMfa('nao-habilitado');
      }
      await deps.codigos.removerDoUsuario(userId);
      await deps.desafios.removerDoUsuario(userId);
    },

    async regenerarCodigos(userId, senha): Promise<readonly string[]> {
      const usuario = await exigirUsuario(userId);
      await exigirSenha(usuario, senha);

      if ((await deps.fatores.buscarAtivo(userId)) === null) {
        throw new ErroDeMfa('nao-habilitado');
      }
      return emitirCodigos(userId);
    },

    async removerFator(userId): Promise<boolean> {
      const removidos = await deps.fatores.removerDoUsuario(userId);
      await deps.codigos.removerDoUsuario(userId);
      await deps.desafios.removerDoUsuario(userId);
      return removidos > 0;
    },
  };
}
