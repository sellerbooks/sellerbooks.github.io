-- Marketplace OAuth state hardening and generic OAuth completion
alter table public.sellerbooks_api_oauth_states
  add column if not exists marketplace_id text;

create index if not exists sellerbooks_api_oauth_states_marketplace_idx
  on public.sellerbooks_api_oauth_states(marketplace_id);

update public.sellerbooks_api_oauth_states s
set marketplace_id = c.marketplace_id
from public.sellerbooks_api_connections c
where c.id = s.connection_id
  and s.marketplace_id is null;

create or replace function public.sellerbooks_api_create_oauth_state(
  p_owner_user_id uuid,
  p_store_id text,
  p_connection_id uuid,
  p_state_hash text,
  p_expires_at timestamptz
)
returns public.sellerbooks_api_oauth_states
language plpgsql
security definer
set search_path=public
as $$
declare
  v_row public.sellerbooks_api_oauth_states;
  v_marketplace text;
begin
  if p_owner_user_id is null
     or nullif(trim(p_store_id),'') is null
     or p_connection_id is null
     or nullif(trim(p_state_hash),'') is null
     or p_expires_at is null then
    raise exception 'OAuth state parameters are required';
  end if;

  select marketplace_id
    into v_marketplace
  from public.sellerbooks_api_connections
  where id=p_connection_id
    and owner_user_id=p_owner_user_id
    and store_id=trim(p_store_id);

  if v_marketplace is null then
    raise exception 'API connection not found';
  end if;

  insert into public.sellerbooks_api_oauth_states
    (owner_user_id,store_id,connection_id,marketplace_id,state_hash,expires_at)
  values
    (p_owner_user_id,trim(p_store_id),p_connection_id,v_marketplace,trim(p_state_hash),p_expires_at)
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.sellerbooks_api_consume_oauth_state_v2(
  p_state_hash text
)
returns table(
  owner_user_id uuid,
  store_id text,
  connection_id uuid,
  marketplace_id text
)
language plpgsql
security definer
set search_path=public
as $$
begin
  return query
  update public.sellerbooks_api_oauth_states s
     set consumed_at=now()
   where s.state_hash=trim(p_state_hash)
     and s.consumed_at is null
     and s.expires_at>now()
  returning s.owner_user_id,s.store_id,s.connection_id,s.marketplace_id;
end;
$$;

create or replace function public.sellerbooks_api_complete_marketplace_oauth(
  p_connection_id uuid,
  p_store_id text,
  p_marketplace text,
  p_external_store_id text,
  p_credential text
)
returns public.sellerbooks_api_connections
language plpgsql
security definer
set search_path=public,vault
as $$
declare
  v_row public.sellerbooks_api_connections;
  v_store public.sellerbooks_stores;
  v_secret_id uuid;
begin
  if p_connection_id is null
     or nullif(trim(p_store_id),'') is null
     or nullif(trim(p_marketplace),'') is null
     or nullif(trim(p_external_store_id),'') is null
     or nullif(trim(p_credential),'') is null then
    raise exception 'OAuth completion parameters are required';
  end if;

  select * into v_store
  from public.sellerbooks_stores
  where id=trim(p_store_id);

  if not found then
    raise exception 'Store not found';
  end if;

  if trim(p_external_store_id) <> trim(v_store.id) then
    raise exception 'External store ID tidak sama dengan Store ID akun toko';
  end if;

  select * into v_row
  from public.sellerbooks_api_connections
  where id=p_connection_id
    and store_id=v_store.id
    and lower(marketplace)=lower(trim(p_marketplace))
  for update;

  if not found then
    raise exception 'API connection not found';
  end if;

  if v_row.vault_secret_id is not null then
    perform vault.update_secret(
      v_row.vault_secret_id,
      p_credential,
      'sellerbooks_api_'||replace(v_row.id::text,'-',''),
      'SellerBooks marketplace OAuth credential'
    );
    v_secret_id:=v_row.vault_secret_id;
  else
    v_secret_id:=vault.create_secret(
      p_credential,
      'sellerbooks_api_'||replace(v_row.id::text,'-',''),
      'SellerBooks marketplace OAuth credential'
    );
  end if;

  update public.sellerbooks_api_connections
     set vault_secret_id=v_secret_id,
         connection_status='CONNECTED',
         sync_enabled=true,
         last_success_at=now(),
         last_error=null,
         updated_at=now()
   where id=v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.sellerbooks_api_consume_oauth_state_v2(text) to service_role;
grant execute on function public.sellerbooks_api_complete_marketplace_oauth(uuid,text,text,text,text) to service_role;
