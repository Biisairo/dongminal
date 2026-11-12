package apierr

// Telegram 알림 설정 API(`/api/telegram/*`)의 코드 (TELEGRAM_BRIDGE_SRS FR-TGB-1~10).
// 본문은 fs 방언 `{code,message}` 다.
const (
	CodeTelegramUnavailable   = "telegram_unavailable"
	CodeTelegramTokenInvalid  = "telegram_token_invalid"
	CodeTelegramUnreachable   = "telegram_unreachable"
	CodeTelegramConfigInvalid = "telegram_config_invalid"
	CodeTelegramNoToken       = "telegram_no_token"
)

var telegramCodes = []string{
	CodeTelegramUnavailable, CodeTelegramTokenInvalid,
	CodeTelegramUnreachable, CodeTelegramConfigInvalid, CodeTelegramNoToken,
}
