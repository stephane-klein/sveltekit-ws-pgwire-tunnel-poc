/*
 * pg_session_identity
 *
 * Pin a verified identity to a PostgreSQL session.
 *
 * The tunnel injects a signed JWT in the startup packet as "app.token".
 * The ClientAuthentication_hook verifies the token and stores its claims in
 * backend memory.  SQL functions expose the identity, with no setter.
 */

#include "postgres.h"

#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>

#include "fmgr.h"
#include "libpq/auth.h"
#include "libpq/libpq-be.h"
#include "miscadmin.h"
#include "nodes/pg_list.h"
#include "utils/builtins.h"
#include "utils/fmgroids.h"
#include "utils/fmgrprotos.h"
#include "utils/guc.h"
#include "utils/jsonb.h"
#include "utils/memutils.h"
#include "utils/timestamp.h"
#include "datatype/timestamp.h"

PG_MODULE_MAGIC;

/* GUCs */
static char *session_identity_secret = NULL;
static char *session_identity_audience = NULL;
static char *session_identity_issuer = NULL;
static char *session_identity_role = NULL;
static char *session_identity_token_parameter = NULL;
static int   session_identity_leeway = 30;
static bool  session_identity_enabled = true;
static bool  session_identity_require_jti = true;

typedef struct SessionIdentity
{
    char       *sub;
    char       *jti;
    int32       ver;
    TimestampTz exp;
    char       *claims;
} SessionIdentity;

static SessionIdentity *current_identity = NULL;
static ClientAuthentication_hook_type prev_client_auth_hook = NULL;

PGDLLEXPORT void _PG_init(void);

static void pg_session_identity_auth(Port *port, int status);
static char *find_startup_option(Port *port, const char *name);
static void clear_startup_option(Port *port, const char *name);
static SessionIdentity *verify_token(const char *token);
static char *b64url_decode(const char *input, int len, int *out_len);
static int b64url_value(char c);
static Jsonb *parse_jsonb_or_fatal(const char *json);
static char *jsonb_get_text(Jsonb *jb, const char *key);
static TimestampTz unix_seconds_to_timestamptz(int64 seconds);
static void store_identity(SessionIdentity *id);

void
_PG_init(void)
{
    DefineCustomStringVariable("pg_session_identity.secret",
                               "HS256 secret used to verify session tokens.",
                               NULL,
                               &session_identity_secret,
                               NULL,
                               PGC_SUSET,
                               GUC_NO_SHOW_ALL,
                               NULL, NULL, NULL);

    DefineCustomStringVariable("pg_session_identity.audience",
                               "Expected JWT audience (aud). Empty disables the check.",
                               NULL,
                               &session_identity_audience,
                               NULL,
                               PGC_SUSET,
                               0,
                               NULL, NULL, NULL);

    DefineCustomStringVariable("pg_session_identity.issuer",
                               "Expected JWT issuer (iss). Empty disables the check.",
                               NULL,
                               &session_identity_issuer,
                               NULL,
                               PGC_SUSET,
                               0,
                               NULL, NULL, NULL);

    DefineCustomStringVariable("pg_session_identity.role",
                               "PostgreSQL role protected by this extension.",
                               NULL,
                               &session_identity_role,
                               "app_user",
                               PGC_SUSET,
                               0,
                               NULL, NULL, NULL);

    DefineCustomStringVariable("pg_session_identity.token_parameter",
                               "Startup packet parameter carrying the JWT.",
                               NULL,
                               &session_identity_token_parameter,
                               "app.token",
                               PGC_SUSET,
                               0,
                               NULL, NULL, NULL);

    DefineCustomIntVariable("pg_session_identity.leeway",
                            "Clock skew leeway in seconds.",
                            NULL,
                            &session_identity_leeway,
                            30,
                            0, 3600,
                            PGC_SUSET,
                            0,
                            NULL, NULL, NULL);

    DefineCustomBoolVariable("pg_session_identity.enabled",
                             "Enable session identity verification.",
                             NULL,
                             &session_identity_enabled,
                             true,
                             PGC_SUSET,
                             0,
                             NULL, NULL, NULL);

    DefineCustomBoolVariable("pg_session_identity.require_jti",
                             "Require a jti claim in every token.",
                             NULL,
                             &session_identity_require_jti,
                             true,
                             PGC_SUSET,
                             0,
                             NULL, NULL, NULL);

    MarkGUCPrefixReserved("pg_session_identity");

    if (!process_shared_preload_libraries_in_progress)
    {
        elog(WARNING, "pg_session_identity must be loaded via shared_preload_libraries");
        return;
    }

    prev_client_auth_hook = ClientAuthentication_hook;
    ClientAuthentication_hook = pg_session_identity_auth;
}

static void
pg_session_identity_auth(Port *port, int status)
{
    const char *token;
    SessionIdentity *identity;

    if (prev_client_auth_hook)
        prev_client_auth_hook(port, status);

    if (status != STATUS_OK)
        return;
    if (!session_identity_enabled)
        return;

    if (session_identity_role == NULL ||
        port->user_name == NULL ||
        strcmp(port->user_name, session_identity_role) != 0)
        return;

    if (session_identity_secret == NULL || session_identity_secret[0] == '\0')
        ereport(FATAL,
                (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                 errmsg("pg_session_identity.secret is not configured")));

    token = find_startup_option(port, session_identity_token_parameter);
    if (token == NULL || token[0] == '\0')
        ereport(FATAL,
                (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                 errmsg("missing session token")));

    identity = verify_token(token);
    store_identity(identity);

    clear_startup_option(port, session_identity_token_parameter);

    ereport(LOG,
            (errmsg("pg_session_identity: authenticated sub=\"%s\" jti=\"%s\"",
                    identity->sub,
                    identity->jti ? identity->jti : "")));
}

static char *
find_startup_option(Port *port, const char *name)
{
    ListCell   *lc;

    if (port->guc_options == NIL || name == NULL)
        return NULL;

    lc = list_head(port->guc_options);
    while (lc != NULL)
    {
        char *key = (char *) lfirst(lc);

        lc = lnext(port->guc_options, lc);
        if (lc == NULL)
            break;

        if (strcmp(key, name) == 0)
            return (char *) lfirst(lc);

        lc = lnext(port->guc_options, lc);
    }

    return NULL;
}

static void
clear_startup_option(Port *port, const char *name)
{
    char *value = find_startup_option(port, name);

    if (value != NULL)
        value[0] = '\0';
}

static int
b64url_value(char c)
{
    if (c >= 'A' && c <= 'Z')
        return c - 'A';
    if (c >= 'a' && c <= 'z')
        return c - 'a' + 26;
    if (c >= '0' && c <= '9')
        return c - '0' + 52;
    if (c == '-')
        return 62;
    if (c == '_')
        return 63;
    return -1;
}

static char *
b64url_decode(const char *input, int len, int *out_len)
{
    int         capacity = (len * 3) / 4 + 4;
    char       *out = palloc(capacity + 1);
    uint32_t    acc = 0;
    int         bits = 0;
    int         n = 0;
    int         i;

    for (i = 0; i < len; i++)
    {
        int         v;

        if (input[i] == '=')
            break;

        v = b64url_value(input[i]);
        if (v < 0)
        {
            pfree(out);
            return NULL;
        }

        acc = (acc << 6) | (uint32_t) v;
        bits += 6;

        if (bits >= 8)
        {
            bits -= 8;
            out[n++] = (char) ((acc >> bits) & 0xFF);
            acc &= (bits == 0) ? 0 : ((1u << bits) - 1);
        }
    }

    out[n] = '\0';
    *out_len = n;
    return out;
}

static Jsonb *
parse_jsonb_or_fatal(const char *json)
{
    Jsonb      *result = NULL;

    PG_TRY();
    {
        result = DatumGetJsonbP(DirectFunctionCall1(jsonb_in,
                                                    CStringGetDatum(json)));
    }
    PG_CATCH();
    {
        FlushErrorState();
        ereport(FATAL,
                (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                 errmsg("invalid session token")));
    }
    PG_END_TRY();

    return result;
}

static char *
jsonb_get_text(Jsonb *jb, const char *key)
{
    FmgrInfo    flinfo;
    LOCAL_FCINFO(fcinfo, 2);
    Datum       result;

    fmgr_info(F_JSONB_OBJECT_FIELD_TEXT, &flinfo);

    InitFunctionCallInfoData(*fcinfo, &flinfo, 2, InvalidOid, NULL, NULL);
    fcinfo->args[0].value = JsonbPGetDatum(jb);
    fcinfo->args[0].isnull = false;
    fcinfo->args[1].value = CStringGetTextDatum(key);
    fcinfo->args[1].isnull = false;

    result = FunctionCallInvoke(fcinfo);

    if (fcinfo->isnull)
        return NULL;

    return TextDatumGetCString(result);
}

static TimestampTz
unix_seconds_to_timestamptz(int64 seconds)
{
    return (TimestampTz)
        ((seconds - (int64) (POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * SECS_PER_DAY)
         * USECS_PER_SEC);
}

static SessionIdentity *
verify_token(const char *token)
{
    char       *copy;
    char       *header_b64;
    char       *payload_b64;
    char       *sig_b64;
    char       *dot1;
    char       *dot2;
    char       *header_json;
    char       *payload_json;
    char       *sig;
    int         header_len;
    int         payload_len;
    int         sig_len;
    Jsonb      *header;
    Jsonb      *payload;
    char       *alg;
    char       *sub;
    char       *jti;
    char       *ver_str;
    char       *exp_str;
    char       *nbf_str;
    char       *aud;
    char       *iss;
    char       *signing_input;
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int digest_len = 0;
    long long   exp_ll;
    long long   nbf_ll = 0;
    char       *endptr;
    time_t      now;
    int32       ver = 0;
    SessionIdentity *identity;

    copy = pstrdup(token);

    dot1 = strchr(copy, '.');
    if (dot1 == NULL)
        ereport(FATAL,
                (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                 errmsg("invalid session token")));
    *dot1 = '\0';

    dot2 = strchr(dot1 + 1, '.');
    if (dot2 == NULL)
        ereport(FATAL,
                (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                 errmsg("invalid session token")));
    *dot2 = '\0';

    header_b64 = copy;
    payload_b64 = dot1 + 1;
    sig_b64 = dot2 + 1;

    if (strchr(sig_b64, '.') != NULL)
        ereport(FATAL,
                (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                 errmsg("invalid session token")));

    header_json = b64url_decode(header_b64, strlen(header_b64), &header_len);
    payload_json = b64url_decode(payload_b64, strlen(payload_b64), &payload_len);
    sig = b64url_decode(sig_b64, strlen(sig_b64), &sig_len);

    if (header_json == NULL || payload_json == NULL || sig == NULL)
        ereport(FATAL,
                (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                 errmsg("invalid session token")));

    header = parse_jsonb_or_fatal(header_json);
    payload = parse_jsonb_or_fatal(payload_json);

    alg = jsonb_get_text(header, "alg");
    if (alg == NULL || strcmp(alg, "HS256") != 0)
        ereport(FATAL,
                (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                 errmsg("invalid session token")));

    signing_input = psprintf("%s.%s", header_b64, payload_b64);

    if (HMAC(EVP_sha256(),
             session_identity_secret, (int) strlen(session_identity_secret),
             (const unsigned char *) signing_input, strlen(signing_input),
             digest, &digest_len) == NULL)
        ereport(FATAL,
                (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                 errmsg("invalid session token")));

    if ((int) digest_len != sig_len ||
        CRYPTO_memcmp(digest, sig, digest_len) != 0)
        ereport(FATAL,
                (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                 errmsg("invalid session token")));

    exp_str = jsonb_get_text(payload, "exp");
    if (exp_str == NULL)
        ereport(FATAL,
                (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                 errmsg("invalid session token")));

    errno = 0;
    endptr = NULL;
    exp_ll = strtoll(exp_str, &endptr, 10);
    if (errno != 0 || endptr == exp_str || *endptr != '\0')
        ereport(FATAL,
                (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                 errmsg("invalid session token")));

    now = time(NULL);
    if (exp_ll < (long long) now - session_identity_leeway)
        ereport(FATAL,
                (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                 errmsg("session token expired")));

    nbf_str = jsonb_get_text(payload, "nbf");
    if (nbf_str != NULL)
    {
        errno = 0;
        endptr = NULL;
        nbf_ll = strtoll(nbf_str, &endptr, 10);
        if (errno != 0 || endptr == nbf_str || *endptr != '\0')
            ereport(FATAL,
                    (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                     errmsg("invalid session token")));
        if (nbf_ll > (long long) now + session_identity_leeway)
            ereport(FATAL,
                    (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                     errmsg("session token not yet valid")));
    }

    aud = jsonb_get_text(payload, "aud");
    if (session_identity_audience != NULL &&
        session_identity_audience[0] != '\0')
    {
        if (aud == NULL || strcmp(aud, session_identity_audience) != 0)
            ereport(FATAL,
                    (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                     errmsg("invalid session token")));
    }

    iss = jsonb_get_text(payload, "iss");
    if (session_identity_issuer != NULL &&
        session_identity_issuer[0] != '\0')
    {
        if (iss == NULL || strcmp(iss, session_identity_issuer) != 0)
            ereport(FATAL,
                    (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                     errmsg("invalid session token")));
    }

    sub = jsonb_get_text(payload, "sub");
    if (sub == NULL || sub[0] == '\0')
        ereport(FATAL,
                (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                 errmsg("invalid session token")));

    jti = jsonb_get_text(payload, "jti");
    if (session_identity_require_jti && (jti == NULL || jti[0] == '\0'))
        ereport(FATAL,
                (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                 errmsg("invalid session token")));

    ver_str = jsonb_get_text(payload, "ver");
    if (ver_str != NULL)
    {
        long        v;

        errno = 0;
        endptr = NULL;
        v = strtol(ver_str, &endptr, 10);
        if (errno != 0 || endptr == ver_str || *endptr != '\0' ||
            v < 0 || v > INT32_MAX)
            ereport(FATAL,
                    (errcode(ERRCODE_INVALID_AUTHORIZATION_SPECIFICATION),
                     errmsg("invalid session token")));
        ver = (int32) v;
    }

    identity = palloc0(sizeof(SessionIdentity));
    identity->sub = sub;
    identity->jti = jti;
    identity->ver = ver;
    identity->exp = unix_seconds_to_timestamptz(exp_ll);
    identity->claims = payload_json;

    return identity;
}

static void
store_identity(SessionIdentity *id)
{
    MemoryContext oldcontext;
    SessionIdentity *copy;

    oldcontext = MemoryContextSwitchTo(TopMemoryContext);

    copy = palloc0(sizeof(SessionIdentity));
    copy->sub = pstrdup(id->sub);
    copy->jti = id->jti ? pstrdup(id->jti) : NULL;
    copy->ver = id->ver;
    copy->exp = id->exp;
    copy->claims = id->claims ? pstrdup(id->claims) : NULL;

    current_identity = copy;

    MemoryContextSwitchTo(oldcontext);
}

PG_FUNCTION_INFO_V1(pg_session_identity_current_sub);

Datum
pg_session_identity_current_sub(PG_FUNCTION_ARGS)
{
    if (current_identity == NULL || current_identity->sub == NULL)
        PG_RETURN_NULL();

    PG_RETURN_TEXT_P(cstring_to_text(current_identity->sub));
}

PG_FUNCTION_INFO_V1(pg_session_identity_current_jti);

Datum
pg_session_identity_current_jti(PG_FUNCTION_ARGS)
{
    if (current_identity == NULL || current_identity->jti == NULL)
        PG_RETURN_NULL();

    PG_RETURN_TEXT_P(cstring_to_text(current_identity->jti));
}

PG_FUNCTION_INFO_V1(pg_session_identity_current_ver);

Datum
pg_session_identity_current_ver(PG_FUNCTION_ARGS)
{
    if (current_identity == NULL)
        PG_RETURN_NULL();

    PG_RETURN_INT32(current_identity->ver);
}

PG_FUNCTION_INFO_V1(pg_session_identity_current_exp);

Datum
pg_session_identity_current_exp(PG_FUNCTION_ARGS)
{
    if (current_identity == NULL)
        PG_RETURN_NULL();

    PG_RETURN_TIMESTAMPTZ(current_identity->exp);
}

PG_FUNCTION_INFO_V1(pg_session_identity_current_claims);

Datum
pg_session_identity_current_claims(PG_FUNCTION_ARGS)
{
    if (current_identity == NULL || current_identity->claims == NULL)
        PG_RETURN_NULL();

    PG_RETURN_DATUM(DirectFunctionCall1(jsonb_in,
                                        CStringGetDatum(current_identity->claims)));
}
