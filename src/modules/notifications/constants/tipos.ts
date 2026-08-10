/**
 * Responsabilidade: o vocabulário fechado das mensagens — o que a plataforma sabe mandar.
 * Consumido por: os templates, o serviço, os canais e o medidor.
 * Regras:
 *  - União literal, não `string`: o tipo vira rótulo de métrica, e rótulo de cardinalidade
 *    aberta destrói o Prometheus. Mensagem nova é mudança de código revisada.
 *  - Só existe aqui o que é **segurança**. Não há categoria informativa, e é por isso que
 *    não há preferência de notificação: o dia em que houver e-mail que não avisa de risco,
 *    a preferência nasce junto com ele e cobre só ele.
 */

export const TIPOS_DE_NOTIFICACAO = [
  'login_novo',
  'senha_alterada',
  'mfa_alterado',
  'conta_bloqueada',
  'reset_de_senha',
  'alerta_de_seguranca',
  'teste',
] as const;

export type TipoDeNotificacao = (typeof TIPOS_DE_NOTIFICACAO)[number];

/**
 * Por que uma mensagem não saiu.
 *
 * Existe para que "não recebi e-mail" tenha diagnóstico. Sem este rótulo, o silêncio do
 * canal é indistinguível de um canal quebrado — e os dois pedem ações opostas.
 */
export const MOTIVOS_DE_SUPRESSAO = [
  'teto',
  'sem_destinatario',
  'dispositivo_conhecido',
  'severidade',
  'nao_configurado',
] as const;

export type MotivoDeSupressao = (typeof MOTIVOS_DE_SUPRESSAO)[number];

/**
 * Por que uma entrega falhou. Vocabulário fechado de propósito: a mensagem do provedor
 * costuma ecoar a requisição inteira, incluindo destinatário e — no reset — o token.
 */
export const CAUSAS_DE_FALHA = ['timeout', 'recusado', 'indisponivel', 'nao_configurado'] as const;

export type CausaDeFalha = (typeof CAUSAS_DE_FALHA)[number];
