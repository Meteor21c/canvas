package main

import (
	"log"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/router"
	"github.com/tigerowo/infinite-canvas/service"
)

func main() {
	if err := config.Load(); err != nil {
		log.Fatal(err)
	}
	if err := service.EnsureDefaultAdmin(); err != nil {
		log.Fatal(err)
	}
	if err := service.EnsureDefaultAgentSkills(); err != nil {
		log.Fatal(err)
	}
	service.StartPromptSyncScheduler()
	service.StartCanvasProjectCleanupScheduler()
	service.MeteorRecoverInterruptedTasks()
	service.StartMeteorMaintenance()
	handler.StartVideoTaskPoller()
	service.WakeComfyBridgePoller()
	address := ":" + config.Cfg.Port
	if config.Cfg.MeteorMode {
		address = "127.0.0.1:" + config.Cfg.Port
	}
	log.Fatal(router.New().Run(address))
}
