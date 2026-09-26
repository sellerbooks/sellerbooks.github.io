-- Harden OAuth RPC permissions: browser roles must never call Vault-writing SECURITY DEFINER functions.
revoke execute on function public.sellerbooks_api_create_oauth_state(uuid,text,uuid,text,timestamptz) from public, anon, authenticated;
revoke execute on function public.sellerbooks_api_consume_oauth_state(text) from public, anon, authenticated;
revoke execute on function public.sellerbooks_api_consume_oauth_state_v2(text) from public, anon, authenticated;
revoke execute on function public.sellerbooks_api_complete_shopee_oauth(uuid,text,text,text,text) from public, anon, authenticated;
revoke execute on function public.sellerbooks_api_complete_marketplace_oauth(uuid,text,text,text,text) from public, anon, authenticated;

grant execute on function public.sellerbooks_api_create_oauth_state(uuid,text,uuid,text,timestamptz) to service_role;
grant execute on function public.sellerbooks_api_consume_oauth_state(text) to service_role;
grant execute on function public.sellerbooks_api_consume_oauth_state_v2(text) to service_role;
grant execute on function public.sellerbooks_api_complete_shopee_oauth(uuid,text,text,text,text) to service_role;
grant execute on function public.sellerbooks_api_complete_marketplace_oauth(uuid,text,text,text,text) to service_role;
