begin;

set local lock_timeout = '5s';

create or replace function public.publish_tool_release(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_packagename text;
    v_version text;
    v_name text;
    v_description text;
    v_download text;
    v_size text;
    v_icon text;
    v_readme_url text;
    v_published_at timestamptz;
    v_tool_id uuid;
    v_release_id uuid;
    v_min_api text;
    v_feature_key text;
    v_feature_value jsonb;
    v_definition_type text;
    v_allowed_values text[];
    v_feature_text text;
    v_insert_columns text[] := array['packagename', 'name', 'description', 'repository', 'website', 'user_id'];
    v_insert_values text[] := array[
        '$1->>''packagename''', '$1->>''name''', '$1->>''description''', '$1->>''repository''', '$1->>''website''',
        'coalesce(nullif($1->>''user_id'', ''''), nullif($1->>''submitted_by'', ''''))::uuid'
    ];
    v_update_values text[] := array[
        'name = excluded.name',
        'description = excluded.description',
        'repository = excluded.repository',
        'website = excluded.website',
        'user_id = coalesce(excluded.user_id, tools.user_id)'
    ];
    v_legacy_column text;
    v_legacy_expression text;
    v_sql text;
begin
    if payload is null or pg_catalog.jsonb_typeof(payload) <> 'object' then
        raise exception 'publish_tool_release payload must be a JSON object';
    end if;

    v_packagename := nullif(pg_catalog.btrim(payload->>'packagename'), '');
    v_version := nullif(pg_catalog.btrim(payload->>'version'), '');
    v_name := nullif(pg_catalog.btrim(payload->>'name'), '');
    v_description := nullif(pg_catalog.btrim(payload->>'description'), '');
    v_download := nullif(pg_catalog.btrim(payload->>'download'), '');
    v_size := nullif(payload->>'size', '');
    v_icon := nullif(payload->>'icon', '');
    v_readme_url := coalesce(nullif(payload->>'readme_url', ''), nullif(payload->>'readmeurl', ''));
    v_published_at := coalesce(nullif(payload->>'published_at', '')::timestamptz, now());
    v_min_api := coalesce(nullif(payload->>'min_api', ''), nullif(payload->'features'->>'minAPI', ''));

    if v_packagename is null or v_version is null or v_name is null or v_description is null or v_download is null then
        raise exception 'publish_tool_release requires packagename, version, name, description and download';
    end if;
    if pg_catalog.jsonb_typeof(payload->'features') not in ('object', 'null') and payload ? 'features' then
        raise exception 'features must be a JSON object';
    end if;
    if v_min_api is not null and v_min_api !~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' then
        raise exception 'min_api must be a semantic version';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_packagename, 0));

    for v_legacy_column, v_legacy_expression in
        select legacy.column_name, legacy.expression
        from (values
            ('version', '$1->>''version'''),
            ('readmeurl', 'coalesce($1->>''readme_url'', $1->>''readmeurl'', '''')'),
            ('license', '$1->>''license'''),
            ('csp_exceptions', '$1->''csp_exceptions'''),
            ('min_api', 'coalesce(nullif($1->>''min_api'', ''''), nullif($1->''features''->>''minAPI'', ''''))'),
            ('features', 'coalesce($1->''features'', ''{}''::jsonb)'),
            ('checksum', '$1->>''checksum'''),
            ('size', '$1->>''size'''),
            ('max_api', '$1->>''max_api'''),
            ('published_at', 'coalesce(nullif($1->>''published_at'', '''')::timestamptz, now())'),
            ('download', '$1->>''download'''),
            ('icon', '$1->>''icon''')
        ) as legacy(column_name, expression)
        where exists (
            select 1
            from pg_catalog.pg_attribute attribute
            where attribute.attrelid = 'public.tools'::pg_catalog.regclass
              and attribute.attname = legacy.column_name
              and attribute.attnum > 0
              and not attribute.attisdropped
        )
    loop
        v_insert_columns := pg_catalog.array_append(v_insert_columns, v_legacy_column);
        v_insert_values := pg_catalog.array_append(v_insert_values, v_legacy_expression);
        v_update_values := pg_catalog.array_append(v_update_values, pg_catalog.format('%I = excluded.%I', v_legacy_column, v_legacy_column));
    end loop;

    v_sql := pg_catalog.format(
        'insert into public.tools (%s) values (%s) on conflict (packagename) do update set %s returning id',
        pg_catalog.array_to_string(v_insert_columns, ', '),
        pg_catalog.array_to_string(v_insert_values, ', '),
        pg_catalog.array_to_string(v_update_values, ', ')
    );
    execute v_sql into v_tool_id using payload;

    insert into public.tool_releases (
        tool_id, version, checksum, size, download, icon, readme_url, license,
        csp_exceptions, min_api, max_api, published_at
    ) values (
        v_tool_id,
        v_version,
        nullif(payload->>'checksum', ''),
        v_size,
        v_download,
        v_icon,
        v_readme_url,
        nullif(payload->>'license', ''),
        payload->'csp_exceptions',
        v_min_api,
        nullif(payload->>'max_api', ''),
        v_published_at
    ) on conflict (tool_id, version) do update set
        checksum = excluded.checksum,
        size = excluded.size,
        download = excluded.download,
        icon = excluded.icon,
        readme_url = excluded.readme_url,
        license = excluded.license,
        csp_exceptions = excluded.csp_exceptions,
        min_api = excluded.min_api,
        max_api = excluded.max_api,
        published_at = excluded.published_at,
        updated_at = now()
    returning id into v_release_id;

    delete from public.tool_release_features existing_feature
    using public.tool_feature_definitions definition
    where existing_feature.release_id = v_release_id
        and definition.key = existing_feature.feature_key
        and definition.source in ('package.json', 'pptb.config.json');

    if pg_catalog.jsonb_typeof(payload->'features') = 'object' then
        for v_feature_key, v_feature_value in
            select feature.key, feature.value
            from pg_catalog.jsonb_each(payload->'features') as feature(key, value)
        loop
            if v_feature_key = 'minAPI' then
                continue;
            end if;

            select definition.value_type, definition.allowed_values
            into v_definition_type, v_allowed_values
            from public.tool_feature_definitions definition
                        where definition.key = v_feature_key
                            and definition.source in ('package.json', 'pptb.config.json');

            if not found then
                                raise exception 'Unknown release feature: %', v_feature_key;
            end if;

            if pg_catalog.jsonb_typeof(v_feature_value) = 'null' then
                raise exception 'Feature % cannot be JSON null', v_feature_key;
            end if;

            if v_definition_type = 'boolean' and pg_catalog.jsonb_typeof(v_feature_value) <> 'boolean' then
                raise exception 'Feature % must be a JSON boolean', v_feature_key;
            end if;
            if v_definition_type = 'enum' and pg_catalog.jsonb_typeof(v_feature_value) <> 'string' then
                raise exception 'Feature % must be a string', v_feature_key;
            end if;

            v_feature_text := v_feature_value #>> '{}';
            if v_definition_type = 'enum' and not (v_feature_text = any(v_allowed_values)) then
                raise exception 'Invalid value for feature %: %', v_feature_key, v_feature_text;
            end if;

            insert into public.tool_release_features (release_id, feature_key, value)
            values (v_release_id, v_feature_key, v_feature_text)
            on conflict (release_id, feature_key) do update set value = excluded.value;
        end loop;
    end if;

    update public.tools
    set current_release_id = v_release_id,
        updated_at = now()
    where id = v_tool_id;

    delete from public.tool_releases old_release
    where old_release.tool_id = v_tool_id
      and old_release.id not in (
          select release.id
          from public.tool_releases release
          where release.tool_id = v_tool_id
          order by (release.id = v_release_id) desc, release.published_at desc nulls last,
                   release.created_at desc, release.id desc
          limit 3
      );

    return pg_catalog.jsonb_build_object(
        'tool_id', v_tool_id,
        'release_id', v_release_id,
        'current_release_id', v_release_id
    );
end;
$$;

revoke all on function public.publish_tool_release(jsonb) from public, anon, authenticated;
grant execute on function public.publish_tool_release(jsonb) to service_role;

commit;
