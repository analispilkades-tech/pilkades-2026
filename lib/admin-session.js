import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SESSION_SECRET = process.env.SESSION_SECRET;

function sha256(text){
  return crypto
    .createHash('sha256')
    .update(text)
    .digest('hex');
}

function readCookie(req,name){

  const cookie=req.headers.cookie||'';

  const match=cookie.match(
    new RegExp(`${name}=([^;]+)`)
  );

  return match?match[1]:null;
}

export async function requireAdmin(req){

  const token=readCookie(req,'admin_session');

  if(!token){
    return {
      ok:false,
      status:401,
      error:'Belum login.'
    };
  }

  const tokenHash=sha256(
    token+SESSION_SECRET
  );

  const { data:session,error }=await supabase
    .from('admin_sessions')
    .select(`
      *,
      admin_users(
        id,
        nama,
        nrp,
        role,
        kecamatan,
        aktif
      )
    `)
    .eq('token_hash',tokenHash)
    .gte('expires_at',new Date().toISOString())
    .maybeSingle();

  if(
    error||
    !session||
    !session.admin_users||
    !session.admin_users.aktif
  ){
    return {
      ok:false,
      status:401,
      error:'Session tidak valid.'
    };
  }

  await supabase
    .from('admin_sessions')
    .update({
      last_access:new Date().toISOString()
    })
    .eq('id',session.id);

  return{
    ok:true,
    admin:session.admin_users
  };
}