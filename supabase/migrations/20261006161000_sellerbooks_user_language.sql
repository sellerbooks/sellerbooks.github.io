/*
  SellerBooks — per-account language preference
  Resolution:
    no saved language -> ID
    saved EN -> EN
    saved ID -> ID
*/
create table if not exists public.sellerbooks_user_language (
    user_id uuid primary key references auth.users(id) on delete cascade,
    language text not null default 'id'
        check (language in ('id','en')),
    updated_at timestamptz not null default now()
);

alter table public.sellerbooks_user_language enable row level security;

drop policy if exists "sellerbooks_user_language_select_own" on public.sellerbooks_user_language;
create policy "sellerbooks_user_language_select_own"
on public.sellerbooks_user_language
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "sellerbooks_user_language_insert_own" on public.sellerbooks_user_language;
create policy "sellerbooks_user_language_insert_own"
on public.sellerbooks_user_language
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "sellerbooks_user_language_update_own" on public.sellerbooks_user_language;
create policy "sellerbooks_user_language_update_own"
on public.sellerbooks_user_language
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create index if not exists idx_sellerbooks_user_language_user_id
on public.sellerbooks_user_language(user_id);

-- Expose only the required Data API operations; RLS still enforces per-user access.
grant select, insert, update on public.sellerbooks_user_language to authenticated;
