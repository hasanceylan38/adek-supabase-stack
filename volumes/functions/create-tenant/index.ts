// ---------------------------------------------------------------------------
// create-tenant — 5 Ekim 2026'da CANLIDAN geri alindi.
//
// Bu fonksiyon canlida ACTIVE olarak calisiyordu ama kaynagi bu depoda
// HIC YOKTU. `supabase functions list --project-ref sissulfwtneagzkwjfog`
// ile ortaya cikti, `supabase functions download create-tenant` ile indirildi.
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
serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({
      error: 'Method not allowed'
    }), {
      status: 405,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({
      error: 'Yetkisiz'
    }), {
      status: 401,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const token = authHeader.replace('Bearer ', '');
  const { data: { user: caller }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !caller) {
    return new Response(JSON.stringify({
      error: 'Geçersiz oturum'
    }), {
      status: 401,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const { data: profile } = await supabase.from('profiles').select('role, tenant_id').eq('id', caller.id).single();
  if (profile?.role !== 'admin') {
    return new Response(JSON.stringify({
      error: 'Sadece sistem yöneticisi kurum oluşturabilir'
    }), {
      status: 403,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  let body;
  try {
    body = await req.json();
  } catch  {
    return new Response(JSON.stringify({
      error: 'Geçersiz JSON'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const name = String(body.name ?? '').trim();
  const adminEmail = String(body.admin_email ?? '').trim();
  const adminPassword = String(body.admin_password ?? '');
  const adminFullName = String(body.admin_full_name ?? 'Kurum Yöneticisi').trim() || 'Kurum Yöneticisi';
  if (!name || !adminEmail || adminPassword.length < 6) {
    return new Response(JSON.stringify({
      error: 'Kurum adı, admin e-posta ve şifre (min 6 karakter) gerekli'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  let userId = null;
  try {
    const { data: slugData, error: slugError } = await supabase.rpc('generate_tenant_slug', {
      tenant_name: name
    });
    if (slugError) throw slugError;
    const isDemo = Boolean(body.is_demo);
    const demoDays = Number(body.demo_days ?? 30);
    const demoExpiresAt = isDemo ? new Date(Date.now() + demoDays * 24 * 60 * 60 * 1000).toISOString() : null;
    const { data: authData, error: createUserError } = await supabase.auth.admin.createUser({
      email: adminEmail,
      password: adminPassword,
      email_confirm: true,
      user_metadata: {
        full_name: adminFullName,
        role: 'institution'
      }
    });
    if (createUserError) throw createUserError;
    if (!authData.user) throw new Error('Kullanıcı oluşturulamadı');
    userId = authData.user.id;
    const { error: profileError } = await supabase.from('profiles').upsert({
      id: userId,
      email: adminEmail,
      full_name: adminFullName,
      role: 'institution',
      is_approved: true
    }, {
      onConflict: 'id'
    });
    if (profileError) throw profileError;
    const { data: tenant, error: tenantError } = await supabase.from('tenants').insert({
      name,
      slug: slugData,
      email: body.email || null,
      phone: body.phone || null,
      website: body.website || null,
      address: body.address || null,
      city: body.city || null,
      country: body.country || 'TR',
      plan: body.plan || 'demo',
      status: 'active',
      is_demo: isDemo,
      demo_started_at: isDemo ? new Date().toISOString() : null,
      demo_expires_at: demoExpiresAt,
      max_students: body.max_students ?? 50,
      max_teachers: body.max_teachers ?? 10,
      max_parents: body.max_parents ?? 100,
      owner_id: userId
    }).select().single();
    if (tenantError) throw tenantError;
    const { error: updateError } = await supabase.from('profiles').update({
      tenant_id: tenant.id
    }).eq('id', userId);
    if (updateError) throw updateError;
    return new Response(JSON.stringify({
      success: true,
      tenant
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    if (userId) {
      try {
        await supabase.auth.admin.deleteUser(userId);
      } catch  {
      // ignore rollback errors
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({
      error: message
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
