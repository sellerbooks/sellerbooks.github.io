create or replace function public.sellerbooks_api_complete_shopee_oauth(
  p_connection_id uuid,
  p_store_id text,
  p_shop_id text,
  p_credential text,
  p_shop_name text default null
)
returns public.sellerbooks_api_connections
language plpgsql
security definer
set search_path to 'public', 'vault'
as $function$
declare
  v_row public.sellerbooks_api_connections;
  v_store public.sellerbooks_stores;
  v_secret_id uuid;
begin
  if p_connection_id is null
     or nullif(trim(p_store_id),'') is null
     or nullif(trim(p_shop_id),'') is null
     or nullif(trim(p_credential),'') is null then
    raise exception 'OAuth completion parameters are required';
  end if;

  -- Internal SellerBooks store ID and external Shopee shop_id are distinct identifiers.
  select * into v_store
    from public.sellerbooks_stores
   where id = trim(p_store_id);

  if not found then
    raise exception 'Store not found';
  end if;

  select * into v_row
    from public.sellerbooks_api_connections
   where id = p_connection_id
     and store_id = v_store.id
     and owner_user_id = v_store.owner_user_id
     and marketplace = 'Shopee'
   for update;

  if not found then
    raise exception 'API connection not found for this store owner';
  end if;

  if v_row.external_store_id is not null
     and trim(v_row.external_store_id) <> trim(p_shop_id) then
    raise exception 'This connection is already associated with a different external shop';
  end if;

  if v_row.vault_secret_id is not null then
    perform vault.update_secret(
      v_row.vault_secret_id,
      p_credential,
      'sellerbooks_api_' || replace(v_row.id::text,'-',''),
      'SellerBooks Shopee OAuth credential'
    );
    v_secret_id := v_row.vault_secret_id;
  else
    v_secret_id := vault.create_secret(
      p_credential,
      'sellerbooks_api_' || replace(v_row.id::text,'-',''),
      'SellerBooks Shopee OAuth credential'
    );
  end if;

  update public.sellerbooks_api_connections
     set vault_secret_id = v_secret_id,
         external_store_id = trim(p_shop_id),
         connection_status = 'CONNECTED',
         sync_enabled = true,
         last_success_at = now(),
         last_error = null,
         updated_at = now()
   where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$function$;
