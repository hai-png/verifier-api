-- Telegram sign-in + partner provisioning.
--
-- User.telegramId: the Telegram account id from a verified Login Widget /
-- MiniApp payload (POST /auth/telegram). Unique and nullable: one Telegram
-- account maps to one dashboard user, and existing email/password users are
-- untouched.
--
-- Workspace.externalId + partner: set by POST /internal/provision so a partner
-- platform (e.g. EshiShop) can address the workspace it provisioned without
-- holding this deployment's internal workspace id. externalId is globally
-- unique; the (partner, externalId) pair is the lookup key for every partner
-- API call, so it carries an index of its own.
--
-- ApiKey.name: display-only label for provisioned keys ("eshishop-auto"); the
-- credential itself is only ever the returned plaintext, and the stored form
-- remains the sha256 in keyHash.

ALTER TABLE `User`
    ADD COLUMN `telegramId` VARCHAR(191) NULL,
    ADD UNIQUE INDEX `User_telegramId_key` (`telegramId`);

ALTER TABLE `Workspace`
    ADD COLUMN `externalId` VARCHAR(191) NULL,
    ADD COLUMN `partner` VARCHAR(191) NULL,
    ADD UNIQUE INDEX `Workspace_externalId_key` (`externalId`),
    ADD INDEX `Workspace_partner_externalId_idx` (`partner`, `externalId`);

ALTER TABLE `ApiKey`
    ADD COLUMN `name` VARCHAR(191) NULL;
