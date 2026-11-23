/* 교차 check 전용 최소 헤더 (rust/scripts/cross-check.sh). 산출물을 링크하지 않는다. */
#pragma once
#include <stddef.h>
void abort(void);
#if defined(_MSC_VER)
#define _byteswap_ulong(x) __builtin_bswap32(x)
#define _byteswap_uint64(x) __builtin_bswap64(x)
#endif
