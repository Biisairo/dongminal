/* 교차 check 전용 최소 헤더 (rust/scripts/cross-check.sh). 산출물을 링크하지 않는다. */
#pragma once
#include <stddef.h>
void *memcpy(void *, const void *, size_t);
void *memmove(void *, const void *, size_t);
void *memset(void *, int, size_t);
int memcmp(const void *, const void *, size_t);
size_t strlen(const char *);
