package model

// Minimal durable receipt survives result-cache cleanup, preventing an old
// browser client task ID from creating a second paid request.
type MeteorTaskReceipt struct {
	ID        string `gorm:"primaryKey"`
	Kind      string `gorm:"primaryKey"`
	UserID    string `gorm:"index"`
	CreatedAt string
}
