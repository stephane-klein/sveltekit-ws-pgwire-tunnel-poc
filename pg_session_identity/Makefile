EXTENSION = pg_session_identity
MODULE_big = pg_session_identity
OBJS = src/pg_session_identity.o
DATA = pg_session_identity--1.0.sql
PGFILEDESC = "pg_session_identity - pin a verified identity to a session"
SHLIB_LINK += -lssl -lcrypto

PG_CONFIG ?= pg_config
PGXS := $(shell $(PG_CONFIG) --pgxs)
include $(PGXS)
