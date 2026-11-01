// Run the portable policy tests without chain dependencies.
#[path = "../policy/policy_api.rs"]
mod policy_api;
#[path = "../policy/policy.rs"]
mod policy;
#[path = "../policy/tests.rs"]
mod tests;
