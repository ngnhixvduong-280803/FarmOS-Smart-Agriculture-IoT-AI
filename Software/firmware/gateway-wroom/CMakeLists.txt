cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_LIST_DIR}/../shared"
    "${CMAKE_CURRENT_LIST_DIR}/../components/environment_sensors"
    "${CMAKE_CURRENT_LIST_DIR}/../components/onboarding_ble"
)
file(STRINGS "${CMAKE_CURRENT_LIST_DIR}/../VERSION" PROJECT_VER LIMIT_COUNT 1)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_LIST_DIR}/../VERSION")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(farmos_gateway)
