import { supabase } from './supabase.js';

export async function applyPetugasResult({
  operation,
  petugas,
  chatId = null,
  kecamatan,
  desa,
  tps,
  votes,
  source = 'TELEGRAM_BOT',
  inputFormat = null
}) {
  const { data, error } = await supabase.rpc('petugas_result_apply', {
    p_operation: operation,
    p_nrp: petugas?.nrp,
    p_chat_id: chatId,
    p_kecamatan: kecamatan,
    p_desa: desa,
    p_tps: tps,
    p_votes: votes,
    p_source: source,
    p_input_format: inputFormat
  });

  if (error) {
    console.error('[RESULT ENGINE] RPC ERROR:', error);
    return {
      ok: false,
      code: 'ENGINE_ERROR',
      message: 'Mesin penyimpanan hasil mengalami kesalahan. Data tidak diubah.'
    };
  }

  return data || {
    ok: false,
    code: 'EMPTY_ENGINE_RESPONSE',
    message: 'Mesin penyimpanan hasil tidak memberikan respons.'
  };
}
