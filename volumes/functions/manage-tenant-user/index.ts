// ---------------------------------------------------------------------------
// manage-tenant-user — 5 Ekim 2026'da CANLIDAN geri alindi.
//
// Bu fonksiyon canlida ACTIVE olarak calisiyordu ama kaynagi bu depoda
// HIC YOKTU. `supabase functions list --project-ref sissulfwtneagzkwjfog`
// ile ortaya cikti, `supabase functions download manage-tenant-user` ile indirildi.
//
// ⚠️ Bu DERLENMIS cikti (eszip paketi), ozgun kaynak degil. TypeScript tip
// aciklamalari silinmis durumda; davranis aynidir, bicim degildir.
// Ozgun kaynak bulunursa bu dosya onunla degistirilmelidir.
//
// Gizli ayarlar: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (platform saglar).
// ---------------------------------------------------------------------------

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Max-Age': '86400'
};
const MANAGEABLE_ROLES = new Set([
  'teacher',
  'student',
  'parent'
]);
serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  if (req.method !== 'POST') {
    return json({
      error: 'Method not allowed'
    }, 405);
  }
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({
      error: 'Yetkisiz'
    }, 401);
  }
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const admin = createClient(supabaseUrl, serviceKey);
  const token = authHeader.replace('Bearer ', '');
  const { data: { user: caller }, error: authError } = await admin.auth.getUser(token);
  if (authError || !caller) {
    return json({
      error: 'Geçersiz oturum'
    }, 401);
  }
  const { data: callerProfile, error: callerProfileError } = await admin.from('profiles').select('role, tenant_id').eq('id', caller.id).single();
  if (callerProfileError || !callerProfile) {
    return json({
      error: 'Profil bulunamadı'
    }, 403);
  }
  const isAdmin = callerProfile.role === 'admin';
  const isInstitution = callerProfile.role === 'institution' && !!callerProfile.tenant_id;
  if (!isAdmin && !isInstitution) {
    return json({
      error: 'Bu işlem için yetkiniz yok'
    }, 403);
  }
  const tenantId = isInstitution ? callerProfile.tenant_id : null;
  let body;
  try {
    body = await req.json();
  } catch  {
    return json({
      error: 'Geçersiz JSON'
    }, 400);
  }
  const action = String(body.action ?? '');
  try {
    if (action === 'create') {
      return await handleCreate(admin, body, tenantId, isAdmin);
    }
    if (action === 'update_password') {
      return await handleUpdatePassword(admin, body, tenantId, isAdmin);
    }
    if (action === 'delete') {
      return await handleDelete(admin, body, tenantId, isAdmin);
    }
    if (action === 'list') {
      return await handleList(admin, body, tenantId, isAdmin);
    }
    return json({
      error: 'Geçersiz action'
    }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({
      error: message
    }, 400);
  }
});
async function handleCreate(admin, body, tenantId, isAdmin) {
  const role = String(body.role ?? '');
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const fullName = String(body.full_name ?? '').trim();
  const phone = body.phone ? String(body.phone).trim() : null;
  const grade = body.grade ? String(body.grade).trim() : null;
  const targetTenantId = isAdmin ? String(body.tenant_id ?? '').trim() : tenantId;
  if (!MANAGEABLE_ROLES.has(role)) {
    throw new Error('Geçersiz rol');
  }
  if (!targetTenantId) {
    throw new Error('Kurum bilgisi bulunamadı');
  }
  if (!email || !password || password.length < 6 || !fullName) {
    throw new Error('Ad, e-posta ve şifre (min 6 karakter) gerekli');
  }
  let userId = null;
  try {
    const { data: authData, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        role
      }
    });
    if (createError) throw createError;
    if (!authData.user) throw new Error('Kullanıcı oluşturulamadı');
    userId = authData.user.id;
    const profileRow = {
      id: userId,
      email,
      full_name: fullName,
      role,
      tenant_id: targetTenantId,
      phone,
      is_approved: true,
      updated_at: new Date().toISOString()
    };
    if (grade) profileRow.grade = grade;
    const { error: profileError } = await admin.from('profiles').upsert(profileRow, {
      onConflict: 'id'
    });
    if (profileError) throw profileError;
    return json({
      success: true,
      user: {
        id: userId,
        email,
        full_name: fullName,
        role
      }
    });
  } catch (error) {
    if (userId) {
      try {
        await admin.auth.admin.deleteUser(userId);
      } catch  {
      // ignore rollback errors
      }
    }
    throw error;
  }
}
async function handleList(admin, body, tenantId, isAdmin) {
  const role = body.role ? String(body.role) : null;
  const targetTenantId = isAdmin ? String(body.tenant_id ?? '').trim() : tenantId;
  if (!targetTenantId) {
    throw new Error('Kurum bilgisi bulunamadı');
  }
  if (role && !MANAGEABLE_ROLES.has(role)) {
    throw new Error('Geçersiz rol');
  }
  let query = admin.from('profiles').select('*').eq('tenant_id', targetTenantId).order('created_at', {
    ascending: false
  });
  if (role) {
    query = query.eq('role', role);
  }
  const { data, error } = await query;
  if (error) throw error;
  return json({
    success: true,
    users: data ?? []
  });
}
async function handleUpdatePassword(admin, body, tenantId, isAdmin) {
  const userId = String(body.user_id ?? '');
  const password = String(body.password ?? '');
  if (!userId || password.length < 6) {
    throw new Error('Kullanıcı ID ve şifre (min 6 karakter) gerekli');
  }
  await assertCanManageUser(admin, userId, tenantId, isAdmin);
  const { error } = await admin.auth.admin.updateUserById(userId, {
    password
  });
  if (error) throw error;
  return json({
    success: true
  });
}
async function handleDelete(admin, body, tenantId, isAdmin) {
  const userId = String(body.user_id ?? '');
  if (!userId) throw new Error('Kullanıcı ID gerekli');
  await assertCanManageUser(admin, userId, tenantId, isAdmin);
  const { error: authError } = await admin.auth.admin.deleteUser(userId);
  if (authError) throw authError;
  await admin.from('profiles').delete().eq('id', userId);
  return json({
    success: true
  });
}
async function assertCanManageUser(admin, userId, tenantId, isAdmin) {
  const { data: target, error } = await admin.from('profiles').select('role, tenant_id').eq('id', userId).single();
  if (error || !target) throw new Error('Kullanıcı bulunamadı');
  if (!MANAGEABLE_ROLES.has(String(target.role))) {
    throw new Error('Bu kullanıcı türü yönetilemez');
  }
  if (!isAdmin && target.tenant_id !== tenantId) {
    throw new Error('Bu kullanıcı sizin kurumunuza ait değil');
  }
}
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
