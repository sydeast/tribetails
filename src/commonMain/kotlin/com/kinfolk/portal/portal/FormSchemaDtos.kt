package com.kinfolk.portal.portal

enum class FormFieldType { Text, Textarea, Select, MultiSelect, Date, Number, Checkbox, Phone, Email }

data class FormField(
    val key: String,
    val label: String,
    val type: FormFieldType,
    val required: Boolean,
    val helperText: String?,
    val placeholder: String?,
    val options: List<String>?,
    val defaultValue: String?,
    val group: String?,
)

data class FormSection(
    val title: String,
    val description: String?,
    val fields: List<FormField>,
)

data class FormSchema(
    val id: String,
    val name: String,
    val description: String?,
    val sections: List<FormSection>,
    val version: Int,
)
