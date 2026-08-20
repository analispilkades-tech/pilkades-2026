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

  const cookie =
    req.headers.cookie || '';

  const match =
    cookie.match(
      new RegExp(
        `${name}=([^;]+)`
      )
    );

  return match
    ? match[1]
    : null;
}

export default async function handler(req,res){

  try{

    const token =
      readCookie(
        req,
        'admin_session'
      );

    if(token){

      await supabase
        .from('admin_sessions')
        .delete()
        .eq(
          'token_hash',
          sha256(
            token + SESSION_SECRET
          )
        );

    }

    const secure =
      process.env.VERCEL
        ? '; Secure'
        : '';

    res.setHeader(
      'Set-Cookie',
      `admin_session=; HttpOnly; Path=/; SameSite=Lax${secure}; Max-Age=0`
    );

    return res.status(200).json({
      ok:true
    });

  }catch(err){

    console.error(
      '[ADMIN LOGOUT]',
      err
    );

    return res.status(500).json({
      ok:false
    });

  }

}
