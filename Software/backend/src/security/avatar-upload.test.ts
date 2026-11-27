import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { avatarStorageDir, cleanUserAvatars, saveAvatar, userAvatarPrefix } from "../api/avatar-upload";

test("avatar retention ensures strictly 1 file per user and isolates users", () => {
  const user1 = "U_TEST_AVATAR_USER_1";
  const user2 = "U_TEST_AVATAR_USER_2";
  const dir = avatarStorageDir();

  // Clean initial state for test users
  cleanUserAvatars(user1);
  cleanUserAvatars(user2);

  const prefix1 = userAvatarPrefix(user1);
  const prefix2 = userAvatarPrefix(user2);
  assert.equal(prefix1.length, 24);
  assert.notEqual(prefix1, prefix2);

  // User 1 uploads first avatar
  const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const file1 = saveAvatar(user1, fakeJpg, ".jpg");
  assert.ok(fs.existsSync(path.join(dir, file1)));
  assert.ok(file1.startsWith(`${prefix1}-`));

  // User 2 uploads an avatar
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const file2 = saveAvatar(user2, fakePng, ".png");
  assert.ok(fs.existsSync(path.join(dir, file2)));
  assert.ok(file2.startsWith(`${prefix2}-`));

  // User 1 uploads a new avatar -> old file1 MUST be deleted, file2 MUST remain untouched
  const file1Updated = saveAvatar(user1, fakePng, ".png");
  assert.notEqual(file1, file1Updated);
  assert.ok(!fs.existsSync(path.join(dir, file1)), "Old avatar of user 1 must be deleted");
  assert.ok(fs.existsSync(path.join(dir, file1Updated)), "New avatar of user 1 must exist");
  assert.ok(fs.existsSync(path.join(dir, file2)), "Avatar of user 2 must not be deleted");

  // Cleaning user 1 removes user 1's avatar, keeps user 2's
  cleanUserAvatars(user1);
  assert.ok(!fs.existsSync(path.join(dir, file1Updated)), "Avatar of user 1 must be cleaned");
  assert.ok(fs.existsSync(path.join(dir, file2)), "Avatar of user 2 must still remain");

  // Clean user 2 teardown
  cleanUserAvatars(user2);
  assert.ok(!fs.existsSync(path.join(dir, file2)));
});
