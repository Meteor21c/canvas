package service

import (
	"log"
	"sync"

	"github.com/robfig/cron/v3"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const defaultPromptSyncCron = "0 0 * * *"

var (
	promptSyncCron      *cron.Cron
	promptSyncOnce      sync.Once
	promptSyncMu        sync.Mutex
	promptBootstrapOnce sync.Once
	promptSyncRunMu     sync.Mutex
)

func StartPromptSyncScheduler() {
	promptSyncOnce.Do(func() {
		promptSyncCron = cron.New()
		promptSyncCron.Start()
	})
	RefreshPromptSyncScheduler()
	if config.Cfg.MeteorMode {
		promptBootstrapOnce.Do(func() { go bootstrapMeteorPrompts() })
	}
}

// Bootstrap a useful prompt library without waiting until the next midnight.
// Sources are fixed in code, fetched sequentially, and never invoke a model.
func bootstrapMeteorPrompts() {
	_, count, err := repository.ListPrompts(model.Query{})
	if err != nil || count > 0 {
		return
	}
	promptSyncRunMu.Lock()
	defer promptSyncRunMu.Unlock()
	for _, category := range []string{"awesome-gpt-image", "awesome-gpt4o-image-prompts"} {
		if _, err := SyncPromptCategory(category); err == nil {
			log.Printf("meteor prompt library ready category=%s", category)
			return
		}
	}
	log.Print("meteor prompt bootstrap unavailable; daily sync will retry")
}

func RefreshPromptSyncScheduler() {
	promptSyncMu.Lock()
	defer promptSyncMu.Unlock()
	if promptSyncCron == nil {
		return
	}
	for _, entry := range promptSyncCron.Entries() {
		promptSyncCron.Remove(entry.ID)
	}
	settings, err := repository.GetSettings()
	if err != nil {
		log.Printf("load prompt sync setting failed err=%v", err)
		return
	}
	setting := normalizePromptSyncSetting(settings.Private.PromptSync)
	if setting.Enabled == nil || !*setting.Enabled {
		return
	}
	if _, err := promptSyncCron.AddFunc(setting.Cron, SyncRemotePromptCategories); err != nil {
		log.Printf("add prompt sync cron failed cron=%s err=%v", setting.Cron, err)
	}
}

func SyncRemotePromptCategories() {
	promptSyncRunMu.Lock()
	defer promptSyncRunMu.Unlock()
	for _, category := range repository.PromptCategories() {
		if !category.Remote {
			continue
		}
		log.Printf("scheduled prompt sync start category=%s", category.Category)
		if _, err := SyncPromptCategory(category.Category); err != nil {
			log.Printf("scheduled prompt sync failed category=%s err=%v", category.Category, err)
			continue
		}
		log.Printf("scheduled prompt sync done category=%s", category.Category)
	}
}

func normalizePromptSyncSetting(setting model.PromptSyncSetting) model.PromptSyncSetting {
	if setting.Cron == "" {
		setting.Cron = defaultPromptSyncCron
	}
	if setting.Enabled == nil {
		enabled := true
		setting.Enabled = &enabled
	}
	return setting
}
